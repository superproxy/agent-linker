/**
 * 渠道 botAgent 共享的网关会话逻辑（方案 B）。
 *
 * 两个 adapter（个人微信 weixin-bot / 企业微信 wecom-bot）共用的部分：
 *   1. streamChat —— POST /v1/chat/completions (stream=true) 解析 SSE，
 *      分离 reasoning_content(思考) 与 content(正文)。
 *   2. runChatSession —— 单轮完整会话编排：
 *      - 思考块缓冲：正文第一条输出前 flush；正文迟到时按量兜底 flush
 *        （🤔 前缀一次性推送，避免逐 token 刷屏）；
 *      - 正文分段推送（切块策略由调用方提供：微信按字符 2000，企微按字节 2048）；
 *      - 每块发送失败重试一次；
 *      - 网关异常时推送 ⚠️ 错误摘要。
 *
 * 多轮记忆：sessionKey → 网关持久会话（有记忆），botAgent 无状态。
 */

export interface StreamOutput {
  /** 正文累积 */
  text: string;
  /** 思考累积 */
  reasoning: string;
}

export interface StreamChatParams {
  gatewayUrl: string;
  model: string;
  /** 会话 key（可选）：网关 /v1 收到 channel+userId 时会自行派生任务会话 key */
  sessionKey?: string;
  /** 任务路由扩展字段（linkagent 非标准，网关 /v1 识别）：渠道标识 / 用户 id / agent / 任务 id */
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  message: string;
  signal?: AbortSignal;
  onReasoning?: (delta: string) => void;
  onText?: (delta: string) => void;
}

/** 调 /v1/chat/completions（stream=true），解析 SSE，回调输出增量 */
export async function streamChat(params: StreamChatParams): Promise<StreamOutput> {
  const res = await fetch(`${params.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: params.message }],
      stream: true,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.task ? { task: params.task } : {}),
    }),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`网关 HTTP ${res.status}: ${bodyText.slice(0, 300) || res.statusText}`);
  }

  const out: StreamOutput = { text: '', reasoning: '' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const emit = (raw: string) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice('data: '.length).trim();
      if (data === '[DONE]') continue;
      let chunk: {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string; role?: string } }>;
        error?: { message?: string; code?: string | null };
      };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue; // 非 JSON 事件（如错误文案）跳过
      }
      // 网关流式错误事件（agent chat failed 等）：向上抛出真实原因，
      // 否则静默忽略会导致 bot 端只见「网关无输出」而无法定位问题
      const err = chunk.error;
      if (err) {
        const msg = err.message ?? JSON.stringify(err);
        throw new Error(`网关错误${err.code ? ` [${err.code}]` : ''}: ${msg}`);
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        out.reasoning += delta.reasoning_content;
        params.onReasoning?.(delta.reasoning_content);
      }
      if (delta.content) {
        out.text += delta.content;
        params.onText?.(delta.content);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      emit(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) emit(buf);
  return out;
}

// ── 会话编排 ────────────────────────────────────────────────────────────

/** 思考块兜底 flush：正文迟迟不出时，思考累积达到该长度先发出去 */
const REASONING_FLUSH_AT = 400;
/** 单轮上限 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** 发送失败重试退避 */
const SEND_RETRY_MS = 2_000;

export interface RunChatSessionOptions {
  gatewayUrl: string;
  model: string;
  /** 会话 key（可选）：网关 /v1 收到 channel+userId 时自行派生任务会话 key */
  sessionKey?: string;
  /** 任务路由扩展字段（透传给 streamChat → /v1）：渠道标识 / 用户 id / agent / 任务 id */
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  message: string;
  /** 底层发送一条消息（已切块）。重试由本模块处理 */
  send: (chunk: string) => Promise<void>;
  /** 切块策略：返回分段（微信按字符，企微按字节） */
  split: (text: string) => string[];
  /** 单轮超时，默认 5 分钟 */
  timeoutMs?: number;
  /** 正文累计字符上限：达到即中断请求快速返回（用户只收到前 N 字符）。不设则完整生成 */
  maxTextChars?: number;
  /** 日志回调（可选） */
  log?: (...args: unknown[]) => void;
}

export interface RunChatSessionResult {
  text: string;
  reasoning: string;
}

/**
 * 完整单轮会话：思考块先行（🤔 前缀）+ 正文分段推送。
 * 返回累积文本供调用方记日志。任何阶段失败 → 推送 ⚠️ 摘要（send 失败除外，尽力而为）。
 */
export async function runChatSession(opts: RunChatSessionOptions): Promise<RunChatSessionResult> {
  const { gatewayUrl, model, sessionKey, message, send, split } = opts;  const log = opts.log ?? (() => {});

  let reasoning = '';
  let reasoningFlushed = false;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  const pushChunks = async (text: string): Promise<void> => {
    for (const chunk of split(text)) {
      try {
        await send(chunk);
      } catch (err) {
        log('[chat] send 失败（重试一次）:', err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, SEND_RETRY_MS));
        await send(chunk);
      }
    }
  };

  const flushReasoningNow = async (): Promise<void> => {
    if (reasoningFlushed || !reasoning.trim()) return;
    reasoningFlushed = true;
    await pushChunks(`🤔 ${reasoning.trim()}`).catch((err) =>
      log('[chat] 思考块推送失败:', err instanceof Error ? err.message : err),
    );
  };

  const scheduleReasoningFlush = () => {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      if (!reasoningFlushed && reasoning.length >= REASONING_FLUSH_AT) {
        void flushReasoningNow();
      }
    }, 3_000);
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 达到 maxTextChars 主动截断（快速返回）：与超时/异常区分，不作为错误推送
  let truncated = false;
  let receivedText = '';
  try {
    let textReceived = false;
    const out = await streamChat({
      gatewayUrl,
      model,
      message,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.task ? { task: opts.task } : {}),
      signal: controller.signal,
      onReasoning: (d) => {
        reasoning += d;
        scheduleReasoningFlush();
      },
      onText: (d) => {
        receivedText += d;
        if (!textReceived) {
          textReceived = true;
          void flushReasoningNow(); // 正文第一条输出 → 先推思考块（fire，不等正文）
        }
        // 正文累计达到上限 → 中断请求，让模型提前停、快速返回（已收内容截断发给用户）
        if (opts.maxTextChars && receivedText.length >= opts.maxTextChars && !controller.signal.aborted) {
          truncated = true;
          controller.abort();
        }
      },
    });
    await flushReasoningNow();
    if (out.text.trim()) {
      const capped = opts.maxTextChars ? out.text.trim().slice(0, opts.maxTextChars) : out.text.trim();
      await pushChunks(capped);
    }
    return { text: opts.maxTextChars ? out.text.trim().slice(0, opts.maxTextChars) : out.text, reasoning: out.reasoning };
  } catch (err) {
    // 主动截断（abort）不算失败：把已收到的前 N 字符发给用户即可
    if (truncated) {
      if (reasoning && !reasoningFlushed) await flushReasoningNow().catch(() => {});
      const capped = receivedText.trim().slice(0, opts.maxTextChars ?? Infinity);
      if (capped) await pushChunks(capped).catch(() => {});
      log(`[chat] 正文达上限（${opts.maxTextChars}）截断快速返回`);
      return { text: capped, reasoning };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log('[chat] 处理失败:', errMsg);
    await pushChunks(`⚠️ 处理失败：${errMsg.slice(0, 500)}`).catch(() => {});
    return { text: '', reasoning };
  } finally {
    clearTimeout(timeout);
    if (flushTimer) clearInterval(flushTimer);
  }
}
