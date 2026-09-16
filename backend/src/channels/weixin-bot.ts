/**
 * 个人微信 botAgent（方案 B：独立标准 adapter，不依赖 openclaw 插件运行时）。
 *
 * 架构：
 *   微信用户 ⇄ ilink 长轮询(getUpdates) ⇄ botAgent ⇄ POST /v1/chat/completions (SSE stream)
 *                                           ⇄ SSE 解析 reasoning_content(思考) + content(正文)
 *                                           ⇄ ilink sendMessage 推回微信
 *
 * 多轮会话：sessionKey = "weixin:<from_user_id>" → 网关持久会话（有记忆），botAgent 无状态。
 *
 * 运行方式：
 *   1. 独立进程：pnpm --filter @linkagent/backend bot:weixin
 *   2. gateway 内嵌：gateway.yaml 里 weixin.mode=weixin-bot（默认），gateway 启动后自动拉起本模块，
 *      与插件方式二选一，避免同时跑两套个人微信通道。
 *
 * 环境变量（独立进程模式）：
 *   LINKAGENT_GATEWAY_URL   网关 base（默认 http://127.0.0.1:8787）
 *   LINKAGENT_GATEWAY_MODEL 模型（默认 agent:pi）
 *   LINKAGENT_ACCOUNT_ID    微信登录态账号 id（缺省取 accounts/ 下第一个）
 *   LINKAGENT_STATE_DIR     登录态目录（默认 <repo>/.runtime-state/plugins）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { findInstallRoot } from '../gateway/config.js';
import { runChatSession } from './gateway-chat.js';
import { TaskRouter } from './task-router.js';
import {
  extractText,
  getUpdates,
  loadWeixinAccount,
  sendText,
  type WeixinAccount,
  type WeixinInboundMessage,
} from './ilink-client.js';

// ── 配置默认值 ────────────────────────────────────────────────────────
const REPO_ROOT = findInstallRoot();
const DEFAULT_GATEWAY_URL = process.env.LINKAGENT_GATEWAY_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_GATEWAY_MODEL = process.env.LINKAGENT_GATEWAY_MODEL ?? 'agent:pi';
const DEFAULT_STATE_DIR = process.env.LINKAGENT_STATE_DIR ?? join(REPO_ROOT, '.runtime-state', 'plugins');
const DEFAULT_ACCOUNT_ID = process.env.LINKAGENT_ACCOUNT_ID;

/** 单条微信消息体长度上限（ilink 文本消息建议 <=2000 字符，超出分段发送） */
const MAX_MSG_LEN = 2000;
/** 长轮询异常退避：单次失败 2s 重试，3 连败 30s */
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ── context_token 存储（对齐旧 openclaw 插件的 store 策略）──
// 腾讯每次 getUpdates 入站都下发 context_token，回推 sendMessage 必须原样带回；
// 同一用户存「最新」token（内存 + <account>.context-tokens.json 落盘，与旧插件同路径/格式），
// 发送时取最新值而非当前消息的 token，避免延迟处理时用了过期 token 被腾讯丢弃。
const contextTokenStore = new Map<string, string>(); // `${accountId}:${userId}` -> token

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function loadContextTokens(stateDir: string, accountId: string): number {
  try {
    const file = join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}.context-tokens.json`);
    if (!existsSync(file)) return 0;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    let count = 0;
    for (const [userId, token] of Object.entries(data)) {
      if (typeof token === 'string' && token) {
        contextTokenStore.set(contextTokenKey(accountId, userId), token);
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function saveContextTokens(stateDir: string, accountId: string): void {
  try {
    const dir = join(stateDir, 'openclaw-weixin', 'accounts');
    mkdirSync(dir, { recursive: true });
    const prefix = `${accountId}:`;
    const tokens: Record<string, string> = {};
    for (const [k, v] of contextTokenStore) {
      if (k.startsWith(prefix)) tokens[k.slice(prefix.length)] = v;
    }
    writeFileSync(join(dir, `${accountId}.context-tokens.json`), JSON.stringify(tokens), 'utf8');
  } catch {
    /* 落盘失败不影响运行 */
  }
}

function setContextToken(stateDir: string, accountId: string, userId: string, token: string | undefined): void {
  if (!token) return;
  const key = contextTokenKey(accountId, userId);
  if (contextTokenStore.get(key) === token) return;
  contextTokenStore.set(key, token);
  saveContextTokens(stateDir, accountId);
}

function getContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(accountId, userId));
}

export interface WeixinBotOptions {
  /** 网关 base（默认 http://127.0.0.1:8787） */
  gatewayUrl?: string;
  /** 对话模型（默认 agent:pi） */
  model?: string;
  /** 登录态账号 id（缺省取 accounts/ 下第一个） */
  accountId?: string;
  /** 登录态目录（默认 <repo>/.runtime-state/plugins） */
  stateDir?: string;
  /** 日志回调（缺省 console.log） */
  log?: (...args: unknown[]) => void;
  /** 错误日志回调（缺省 console.error） */
  errLog?: (...args: unknown[]) => void;
}

export interface WeixinBotHandle {
  account: WeixinAccount;
  /** monitor 运行态 promise（abort 后才结束） */
  monitor: Promise<void>;
  /** 优雅停止：abort 长轮询 + 等待消息队列排空 */
  stop(): Promise<void>;
}

/** 按字符切块（微信 2000 字符上限） */
function splitChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * 启动个人微信 botAgent（长轮询 monitor 后台运行，不阻塞调用方）。
 * 既可作为独立进程入口（bot:weixin），也可由 gateway 进程内拉起（weixin.mode=weixin-bot）。
 */
export async function startWeixinBot(options: WeixinBotOptions = {}): Promise<WeixinBotHandle> {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const model = options.model ?? DEFAULT_GATEWAY_MODEL;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const account = loadWeixinAccount(stateDir, options.accountId ?? DEFAULT_ACCOUNT_ID);
  const log = options.log ?? ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const errLog = options.errLog ?? ((...args: unknown[]) => console.error(new Date().toISOString(), ...args));
  // bot 路由层：选中任务缓存（网关 /api/tasks 为单一事实源）
  const router = new TaskRouter({ gatewayUrl, channel: 'weixin' });

  const syncBufPath = join(stateDir, 'openclaw-weixin', 'accounts', `${account.id}.sync.json`);

  const loadSyncBuf = (): string => {
    try {
      const data = JSON.parse(readFileSync(syncBufPath, 'utf8')) as { get_updates_buf?: string };
      return typeof data.get_updates_buf === 'string' ? data.get_updates_buf : '';
    } catch {
      return '';
    }
  };

  const saveSyncBuf = (buf: string): void => {
    try {
      mkdirSync(join(syncBufPath, '..'), { recursive: true });
      writeFileSync(syncBufPath, JSON.stringify({ get_updates_buf: buf }), 'utf8');
    } catch (err) {
      errLog('[bot] 游标落盘失败（不影响运行）:', err);
    }
  };

  // ── 每用户串行队列：同一用户消息按序处理，不同用户并行 ──
  const userChains = new Map<string, Promise<void>>();
  const enqueue = (from: string, task: () => Promise<void>): void => {
    const prev = userChains.get(from) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => {}); // 单条失败不阻断队列
    userChains.set(
      from,
      next.finally(() => {
        if (userChains.get(from) === next) userChains.delete(from);
      }),
    );
  };

  // ── 消息处理：调网关 + 推送 ──
  const handleMessage = async (msg: WeixinInboundMessage): Promise<void> => {
    const from = msg.from_user_id;
    if (!from) return;
    // 正文提取：TEXT 直接取文本；语音走服务端转写 text（无转写降级占位）；表情/图片/文件/视频占位
    const text = extractText(msg);
    if (!text.trim()) {
      log(`[bot] 跳过无内容消息 from=${from}`);
      return;
    }
    log(`[bot] inbound from=${from} text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    // 入站即更新该用户最新 context_token（供回推原样带回）
    setContextToken(stateDir, account.id, from, msg.context_token);

    const isCmd = TaskRouter.isCommand(text);
    const route = isCmd ? null : await router.active(from);
    const out = await runChatSession({
      gatewayUrl,
      model,
      channel: 'weixin',
      userId: from,
      message: text,
      // 命令：网关本地解析回文本；普通消息：按激活任务路由（agent/task 透传）
      ...(!isCmd && route ? { agent: route.agent, task: route.task } : {}),
      send: async (chunk) => {
        await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          to: from,
          text: chunk,
          // 回推 token 取该用户最新已存值（收消息时已刷新），兜底用当前消息自带的
          contextToken: getContextToken(account.id, from) ?? msg.context_token,
          // 对齐旧 openclaw 插件：每次回推携带随机 run_id
          runId: randomUUID(),
        });
      },
      split: (t) => splitChunks(t, MAX_MSG_LEN),
      // 快速返回：正文累计达到 512 字符即中断请求，用户只收到前 512 字符
      maxTextChars: 512,
      log,
    });
    if (isCmd) router.invalidate(from); // 命令改过任务状态，失效缓存
    if (out.text.trim()) {
      log(`[bot] outbound to=${from} len=${out.text.length}`);
    } else if (!out.reasoning.trim()) {
      log(`[bot] 网关无输出 from=${from}`);
    }
  };

  // ── 长轮询 monitor ──
  const runMonitor = async (signal: AbortSignal): Promise<void> => {
    let buf = loadSyncBuf();
    if (buf) log(`[bot] 从上次游标恢复（${buf.length} bytes）`);
    let nextTimeoutMs = 35_000;
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      let resp;
      try {
        resp = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          getUpdatesBuf: buf,
          timeoutMs: nextTimeoutMs,
          abortSignal: signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errLog(`[bot] getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${msg}`);
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        consecutiveFailures += 1;
        errLog(`[bot] getUpdates API 错误 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog('[bot] getUpdates 连续失败，退避 30s');
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await sleep(RETRY_DELAY_MS, signal);
        }
        continue;
      }
      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
        buf = resp.get_updates_buf;
        saveSyncBuf(buf);
      }
      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      for (const msg of resp.msgs ?? []) {
        enqueue(msg.from_user_id, () => handleMessage(msg));
      }
    }
    log('[bot] monitor 已停止');
  };

  log(`[bot] 账号 ${account.id} (${account.userId || '未知用户'})`);
  log(`[bot] 网关 ${gatewayUrl}  模型 ${model}`);
  const restored = loadContextTokens(stateDir, account.id);
  if (restored > 0) log(`[bot] 恢复 ${restored} 个用户 context_token`);
  if (!existsSync(syncBufPath)) log('[bot] 无历史游标，全新开始收消息');
  log(`[bot] 微信长轮询启动（${account.baseUrl}）`);

  const controller = new AbortController();
  const monitor = runMonitor(controller.signal);
  const stop = async (): Promise<void> => {
    controller.abort();
    // 整体 8s 超时：长轮询/消息队列若卡住不阻塞网关优雅退出
    await Promise.race([
      (async () => {
        await monitor.catch(() => {});
        await Promise.allSettled([...userChains.values()]);
      })(),
      new Promise((r) => setTimeout(r, 8_000)),
    ]);
  };
  return { account, monitor, stop };
}

// ── 独立进程入口（pnpm --filter @linkagent/backend bot:weixin）──
// 独立运行入口：tsx src/channels/weixin-bot.ts。
// 注意：esbuild 打包后所有模块共享同一 import.meta.url，不能用 URL 比较；
// 网关内由 gateway/index.ts 以库方式调用 startWeixinBot，bundle 中 argv[1]=index.mjs 不匹配此守卫。
if (process.argv[1] && /(^|[\\/])weixin-bot\.(ts|mjs|js)$/.test(process.argv[1])) {
  const consoleLog = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
  const consoleErr = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);
  startWeixinBot({ log: consoleLog, errLog: consoleErr })
    .then(async (bot) => {
      const shutdown = (signal: string) => {
        consoleLog(`[bot] 收到 ${signal}，优雅退出…`);
        void bot.stop().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 3_000).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      await bot.monitor;
      process.exit(0);
    })
    .catch((err) => {
      consoleErr('[bot] 启动失败:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
