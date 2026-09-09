/**
 * core.channel.reply —— agent 派发核心
 *
 * dispatchReplyWithBufferedBlockDispatcher 是插件回调 host 的 agent 调度入口：
 * 取 ctx.Body 文本 → 按 ctx.SessionKey 路由到 linkagent AgentManager
 * （ACP 持久会话，多轮记忆）→ 流式输出以块交付给插件的 deliver 回调
 * （插件再通过 Bot WS / Agent HTTP API 推送回企业微信）。
 *
 * 微信插件（openclaw-weixin）走另一组入口（与 openclaw 官方语义对齐）：
 *   resolveHumanDelayConfig / createReplyDispatcherWithTyping /
 *   withReplyDispatcher / dispatchReplyFromConfig
 */
import { basename, resolve } from 'node:path';
import { hasControlCommand } from './commands.js';
import { resolveAgentRoute } from './routing.js';

export interface ChannelAgentDispatchParams {
  agentId: string;
  sessionKey: string;
  accountId: string;
  text: string;
  attachments?: Array<{ name: string; mimeType: string; url: string }>;
  signal?: AbortSignal;
}

export interface ChannelAgentDispatch {
  chat(
    params: ChannelAgentDispatchParams,
    cb: {
      onText(delta: string): void;
      onReasoning?(delta: string): void;
      onToolActivity?(name: string): void;
    },
  ): Promise<void>;
}

export interface EnvelopeFormatOptions {
  timezone?: string;
  includeTimestamp: boolean;
  includeElapsed: boolean;
  userTimezone?: string;
}

/** 对齐 openclaw resolveEnvelopeFormatOptions */
export function resolveEnvelopeFormatOptions(cfg?: unknown): EnvelopeFormatOptions {
  const defaults = (cfg as { agents?: { defaults?: { userTimezone?: string } } } | undefined)
    ?.agents?.defaults;
  return {
    timezone: undefined,
    includeTimestamp: true,
    includeElapsed: true,
    userTimezone: defaults?.userTimezone,
  };
}

function sanitizeHeaderPart(value: string): string {
  return value.replace(/[\r\n[\]]/g, ' ').trim();
}

function formatTimestamp(ts: number | Date | undefined, _options: EnvelopeFormatOptions): string | undefined {
  if (ts === undefined) return undefined;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimeAgo(elapsedMs: number): string {
  const sec = Math.round(elapsedMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  return `${day}d`;
}

/** 对齐 openclaw formatAgentEnvelope：`[Channel from +elapsed ts] body` */
export function formatAgentEnvelope(params: {
  channel?: string;
  from?: string;
  timestamp?: number | Date;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
  body: string;
  host?: string;
  ip?: string;
}): string {
  const parts: string[] = [sanitizeHeaderPart(params.channel || 'Channel')];
  const resolved = params.envelope ?? { includeTimestamp: true, includeElapsed: true };
  let elapsed: string | undefined;
  if (resolved.includeElapsed && params.timestamp !== undefined && params.previousTimestamp !== undefined) {
    const ts = params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp;
    const prev = params.previousTimestamp instanceof Date ? params.previousTimestamp.getTime() : params.previousTimestamp;
    const elapsedMs = ts - prev;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) elapsed = formatTimeAgo(elapsedMs);
  }
  const from = params.from?.trim();
  if (from) parts.push(elapsed ? `${sanitizeHeaderPart(from)} +${elapsed}` : sanitizeHeaderPart(from));
  else if (elapsed) parts.push(`+${elapsed}`);
  if (params.host?.trim()) parts.push(sanitizeHeaderPart(params.host));
  if (params.ip?.trim()) parts.push(sanitizeHeaderPart(params.ip));
  const ts = formatTimestamp(params.timestamp, resolved);
  if (ts) parts.push(ts);
  return `[${parts.join(' ')}] ${params.body}`;
}

/** 对齐 openclaw finalizeInboundContext：透传 + 补齐缺省字段（插件已填充 SessionKey/AccountId 等） */
export function finalizeInboundContext<T extends Record<string, unknown>>(
  ctx: T,
  _opts?: { forceBodyForAgent?: boolean; forceBodyForCommands?: boolean; forceChatType?: boolean },
): T & { SessionKey: string; AccountId: string; ChatType: string } {
  const next = { ...ctx } as T & { SessionKey: string; AccountId: string; ChatType: string };
  next.SessionKey = String(ctx.SessionKey ?? 'channel-main');
  next.AccountId = String(ctx.AccountId ?? 'default');
  next.ChatType = String(ctx.ChatType ?? 'direct');
  return next;
}

export interface DispatchDeliverPayload {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  [key: string]: unknown;
}

export interface DispatchReplyParams {
  ctx: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  dispatcherOptions: {
    deliver: (payload: DispatchDeliverPayload) => void | Promise<void>;
    onError?: (err: unknown) => void | Promise<void>;
    [key: string]: unknown;
  };
  toolsAllow?: string[];
  replyOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 思考过程累积器：正文首块输出前，把完整思考以「🤔」标记的消息块先交付，
 * 避免与正文混流/刷屏（思考流先于正文到达，一次收集、一次发送）。
 */
function createReasoningCollector(deliver: (payload: DispatchDeliverPayload) => void | Promise<void>): {
  push(delta: string): void;
  flushBeforeText(): void;
  flush(): void;
} {
  let buf = '';
  let sent = false;
  const CHUNK = 2000;
  const emit = (): void => {
    if (!buf) return;
    let rest = buf;
    buf = '';
    do {
      const chunk = rest.slice(0, CHUNK);
      rest = rest.slice(CHUNK);
      void deliver({ text: `🤔 ${chunk}` });
    } while (rest.length > 0);
  };
  return {
    push(delta) {
      buf += delta;
    },
    flushBeforeText() {
      if (!sent && buf) {
        sent = true;
        emit();
      }
    },
    flush() {
      if (!sent && buf) {
        sent = true;
        emit();
      }
    },
  };
}

/**
 * 流式把 agent 输出切成块交付：24ms 时间窗 + 512 字符上限，
 * 兼顾「流式刷新」体验与 deliver 调用开销（agent 每 token 一次回调）。
 */
function createTextStreamDeliverer(
  deliver: (payload: DispatchDeliverPayload) => void | Promise<void>,
): { push(delta: string): void; flush(): void } {
  let buf = '';
  let timer: NodeJS.Timeout | null = null;
  const send = (): void => {
    if (!buf) return;
    const chunk = buf;
    buf = '';
    void deliver({ text: chunk });
  };
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      send();
    }, 24);
  };
  return {
    push(delta) {
      buf += delta;
      if (buf.length >= 512) send();
      else schedule();
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      send();
    },
  };
}

export interface ReplyChannelApi {
  dispatchReplyWithBufferedBlockDispatcher(
    params: DispatchReplyParams & { agentDispatch: ChannelAgentDispatch },
  ): Promise<{ delivered: boolean }>;
}

/** 派发入口：文本 + 附件 → agentDispatch.chat → deliver 流式块 */
export async function dispatchReplyWithBufferedBlockDispatcher(
  params: DispatchReplyParams,
  agentDispatch: ChannelAgentDispatch,
): Promise<{ delivered: boolean }> {
  const { ctx, dispatcherOptions } = params;
  const { deliver, onError } = dispatcherOptions;
  const rawText = typeof ctx?.Body === 'string' ? ctx.Body : String(ctx?.RawBody ?? '');
  const text = rawText.trim();
  if (!text && !ctx?.Attachments) return { delivered: false };

  const sessionKey = String(ctx.SessionKey ?? 'channel-main');
  const accountId = String(ctx.AccountId ?? 'default');
  const agentId = String(ctx.AgentId ?? 'opencode');
  const attachments = (ctx.Attachments as Array<{ name: string; mimeType: string; url: string }> | undefined) ?? [];

  const stream = createTextStreamDeliverer(deliver);
  const reasoning = createReasoningCollector(deliver);
  let delivered = false;
  try {
    await agentDispatch.chat(
      { agentId, sessionKey, accountId, text, attachments, signal: ctx.Signal as AbortSignal | undefined },
      {
        onText(delta) {
          reasoning.flushBeforeText();
          delivered = true;
          stream.push(delta);
        },
        onReasoning(delta) {
          reasoning.push(delta);
        },
        onToolActivity(name) {
          // 工具动作提示不直接下发（企业微信不适合刷屏），保留扩展点
          void name;
        },
      },
    );
    stream.flush();
    reasoning.flush(); // 兜底：仅有思考无正文时也要让用户看到
    return { delivered };
  } catch (err) {
    stream.flush();
    reasoning.flush();
    if (onError) {
      await onError(err);
    } else {
      throw err;
    }
    return { delivered };
  }
}

// ─────────────────────────────────────────────────────────────
// 微信插件（openclaw-weixin）reply 面：对齐 openclaw 官方语义
// ─────────────────────────────────────────────────────────────

/** 派发器：deliver + onError + typing/humanDelay 附加面 */
export interface ReplyDispatcher {
  deliver(payload: DispatchDeliverPayload): Promise<void> | void;
  onError?(err: unknown, info: { kind: string }): void | Promise<void>;
  typing?: { start(): Promise<void>; stop(): Promise<void> };
  humanDelayMs?: number;
}

/**
 * 读 human-delay 配置（模拟真人打字延迟）：
 *   cfg.agents.<agentId>.humanDelayMs > cfg.agents.defaults.humanDelayMs > 0
 * 返回毫秒数（0 = 关闭）。
 */
export function resolveHumanDelayConfig(cfg: unknown, agentId?: string): number {
  const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
  if (!agents || typeof agents !== 'object') return 0;
  const perAgent =
    agentId && typeof agents[agentId] === 'object'
      ? (agents[agentId] as { humanDelayMs?: unknown }).humanDelayMs
      : undefined;
  const def = (agents.defaults as { humanDelayMs?: unknown } | undefined)?.humanDelayMs;
  const value = typeof perAgent === 'number' ? perAgent : def;
  return typeof value === 'number' && value > 0 ? Math.min(Math.round(value), 60_000) : 0;
}

/**
 * 构造带 typing 心跳 + humanDelay 的派发器（对齐 openclaw createReplyDispatcherWithTyping）。
 * 返回 { dispatcher, replyOptions, markDispatchIdle }：
 *   - dispatcher.deliver：首次交付前应用 humanDelay；每次交付前启动 typing（幂等）
 *   - markDispatchIdle：一次派发结束后调用，停止 typing 心跳、拒绝后续 deliver
 */
export function createReplyDispatcherWithTyping(params: {
  humanDelay?: number;
  typingCallbacks?: { start(): Promise<void>; stop(): Promise<void> };
  deliver(payload: DispatchDeliverPayload): void | Promise<void>;
  onError?(err: unknown, info: { kind: string }): void | Promise<void>;
}): {
  dispatcher: ReplyDispatcher;
  replyOptions: Record<string, unknown>;
  markDispatchIdle(): void;
} {
  const { humanDelay = 0, typingCallbacks, deliver, onError } = params;
  let delayedOnce = false;
  let idle = false;
  const dispatcher: ReplyDispatcher = {
    async deliver(payload) {
      if (idle) return;
      if (!delayedOnce && humanDelay > 0) {
        delayedOnce = true;
        await new Promise((r) => setTimeout(r, humanDelay));
      }
      if (typingCallbacks) await typingCallbacks.start().catch(() => {});
      await deliver(payload);
    },
    onError,
    typing: typingCallbacks,
    humanDelayMs: humanDelay,
  };
  return {
    dispatcher,
    replyOptions: {},
    markDispatchIdle() {
      idle = true;
      if (typingCallbacks) void typingCallbacks.stop().catch(() => {});
    },
  };
}

/** 运行一次派发（对齐 openclaw withReplyDispatcher）；typing 停止由 markDispatchIdle 负责 */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run(): Promise<T>;
}): Promise<T> {
  return await params.run();
}

/**
 * 按配置派发（对齐 openclaw dispatchReplyFromConfig）：
 *   1. 控制命令（/new /reset /stop 等）→ 不喂给 agent，直接回复说明（一期不执行会话重置）
 *   2. 普通消息 → resolveAgentRoute 得 agentId/sessionKey → agentDispatch.chat
 *      → 流式输出经 dispatcher.deliver（带 typing/humanDelay）
 * ctx 字段（weixinMessageToMsgContext + finalizeInboundContext 产物）：
 *   Body/From/To/AccountId/ChatType/SessionKey/CommandBody/CommandAuthorized/MediaPath/MediaType
 */
export async function dispatchReplyFromConfig(
  params: {
    ctx: Record<string, unknown>;
    cfg?: Record<string, unknown>;
    dispatcher: ReplyDispatcher;
    replyOptions?: Record<string, unknown>;
  },
  deps: { agentDispatch: ChannelAgentDispatch },
): Promise<{ delivered: boolean }> {
  const { ctx, cfg, dispatcher } = params;
  const body = typeof ctx.Body === 'string' ? ctx.Body.trim() : '';
  const commandBody = typeof ctx.CommandBody === 'string' ? ctx.CommandBody.trim() : body;

  // 控制命令：一期不执行 /new、/reset 等会话重置，明确提示避免静默吞掉
  if (hasControlCommand(commandBody, cfg)) {
    await dispatcher.deliver({
      text: '已识别控制命令（/new、/reset、/stop 等）。linkagent 渠道一期不执行会话重置，请直接发送消息继续对话。',
    });
    return { delivered: true };
  }

  const channel = String(ctx.OriginatingChannel ?? 'unknown').toLowerCase();
  const accountId = String(ctx.AccountId ?? 'default');
  const route = resolveAgentRoute({
    cfg,
    channel,
    accountId,
    peer: ctx.To ? { kind: 'direct', id: String(ctx.To) } : null,
    defaultAgentId: typeof ctx.AgentId === 'string' ? ctx.AgentId : undefined,
  });
  const agentId = typeof ctx.AgentId === 'string' ? ctx.AgentId : route.agentId;
  const sessionKey = String(ctx.SessionKey ?? route.sessionKey);

  const attachments: Array<{ name: string; mimeType: string; url: string }> = [];
  if (Array.isArray(ctx.Attachments)) {
    for (const a of ctx.Attachments as Array<{ name?: string; mimeType?: string; url?: string }>) {
      if (a?.url) attachments.push({ name: a.name ?? a.url, mimeType: a.mimeType ?? 'application/octet-stream', url: a.url });
    }
  }
  // 微信插件已把入站媒体下载/解密到本地 MediaPath，以 file:// 引用（agent 端可读取）
  if (typeof ctx.MediaPath === 'string' && ctx.MediaPath.trim()) {
    const mediaPath = resolve(ctx.MediaPath);
    if (!attachments.some((a) => a.url === `file://${mediaPath}`)) {
      attachments.push({
        name: basename(mediaPath),
        mimeType: typeof ctx.MediaType === 'string' ? ctx.MediaType : 'application/octet-stream',
        url: `file://${mediaPath}`,
      });
    }
  }

  const reasoning = createReasoningCollector((payload) => dispatcher.deliver(payload));
  let delivered = false;
  try {
    await deps.agentDispatch.chat(
      { agentId, sessionKey, accountId, text: body, attachments, signal: ctx.Signal as AbortSignal | undefined },
      {
        onText(delta) {
          reasoning.flushBeforeText();
          delivered = true;
          void dispatcher.deliver({ text: delta });
        },
        onReasoning(delta) {
          reasoning.push(delta);
        },
        onToolActivity(name) {
          void name;
        },
      },
    );
    reasoning.flush(); // 兜底：仅有思考无正文时也要让用户看到
    return { delivered };
  } catch (err) {
    reasoning.flush();
    if (dispatcher.onError) {
      await dispatcher.onError(err, { kind: 'agent' });
      return { delivered };
    }
    throw err;
  }
}
