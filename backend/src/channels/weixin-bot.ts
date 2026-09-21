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
 *   2. gateway 内嵌：config.yaml 里 weixin.mode=weixin-bot（默认），gateway 启动后自动拉起本模块，
 *      与插件方式二选一，避免同时跑两套个人微信通道。
 *
 * 环境变量（独立进程模式；supervisor 托管时 LINKAGENT_GATEWAY_URL/TOKEN 会被显式置空屏蔽，
 * 回连地址只认共享 config 的 weixin.gatewayUrl 或本机网关推导）：
 *   LINKAGENT_GATEWAY_URL    网关 base（默认 http://127.0.0.1:8787）
 *   LINKAGENT_GATEWAY_MODEL  模型（默认 agent:pi）
 *   LINKAGENT_GATEWAY_TOKEN  网关静态 token（网关开启 auth 时必填；托管时进程自读共享配置）
 *   LINKAGENT_ACCOUNT_ID     微信登录态账号 id（缺省取 accounts/ 下第一个）
 *   LINKAGENT_STATE_DIR      登录态目录（默认 <repo>/.runtime-state/plugins）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getLayout } from '../install/layout.js';
import { loadSharedConfig, resolveChildRuntime } from '../gateway/config.js';
import { runChatSession, GatewayUnauthorizedError } from './gateway-chat.js';
import { TaskRouter } from './task-router.js';
import { HttpUserTokenProvider, type UserTokenProvider } from './user-token.js';
import {
  extractText,
  getUpdates,
  isIlinkSessionExpired,
  loadLatestWeixinAccount,
  sendText,
  type WeixinAccount,
  type WeixinInboundMessage,
} from './ilink-client.js';

// ── 配置默认值 ────────────────────────────────────────────────────────
const DEFAULT_GATEWAY_URL = process.env.LINKAGENT_GATEWAY_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_GATEWAY_MODEL = process.env.LINKAGENT_GATEWAY_MODEL ?? 'agent:pi';
const DEFAULT_GATEWAY_TOKEN = process.env.LINKAGENT_GATEWAY_TOKEN ?? '';
const DEFAULT_STATE_DIR = process.env.LINKAGENT_STATE_DIR ?? getLayout().pluginsState;
const DEFAULT_ACCOUNT_ID = process.env.LINKAGENT_ACCOUNT_ID;

/** 单条微信消息体长度上限（ilink 文本消息建议 <=2000 字符，超出分段发送） */
const MAX_MSG_LEN = 2000;
/** 长轮询异常退避：单次失败 2s 重试，3 连败 30s */
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
/** 登录态失效后不要 2s 连打，等用户重新扫码 */
const SESSION_EXPIRED_DELAY_MS = 60_000;
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
  /** 网关静态 token（开启 auth 时必填） */
  gatewayToken?: string;
  /** 对话模型（默认 agent:pi） */
  model?: string;
  /** 登录态账号 id（缺省取 accounts/ 下第一个） */
  accountId?: string;
  /** 登录态目录（默认 <repo>/.runtime-state/plugins） */
  stateDir?: string;
  /**
   * 用户级 token 解析器（内嵌模式由网关注入，按微信用户签发 ct_ token）。
   * 提供后 bot 按每个用户携带其专属 token；不提供则 external 模式自建 HTTP 引导解析器
   * （用 gatewayToken 调 /api/bot/channel-token 换取），再退化为全局静态 token。
   */
  userTokenProvider?: UserTokenProvider;
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
  const gatewayToken = options.gatewayToken ?? DEFAULT_GATEWAY_TOKEN;
  const model = options.model ?? DEFAULT_GATEWAY_MODEL;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const preferredAccountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
  const account = loadLatestWeixinAccount(stateDir, preferredAccountId);
  const log = options.log ?? ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const errLog = options.errLog ?? ((...args: unknown[]) => console.error(new Date().toISOString(), ...args));
  const ownerId = preferredAccountId?.trim() || account.id;
  if (account.id !== ownerId) {
    log(`[bot] 未找到 ${ownerId}.json，暂用 ${account.id} 的登录态；任务归属按账号槽 ${ownerId}`);
  }

  // 用户级 token：内嵌模式用网关注入的签发器；external 独立进程用静态 token 经引导接口换取（落盘缓存）
  const tokenProvider: UserTokenProvider | undefined =
    options.userTokenProvider ??
    (gatewayToken
      ? new HttpUserTokenProvider({ gatewayUrl, gatewayToken, stateDir, accountId: ownerId, log })
      : undefined);

  // bot 路由层：选中任务缓存（网关 /api/tasks 为单一事实源），按用户携带用户级 token
  const router = new TaskRouter({
    gatewayUrl,
    channel: 'weixin',
    ownerUsername: ownerId,
    ...(gatewayToken ? { gatewayToken } : {}),
    ...(tokenProvider
      ? { resolveToken: (userId: string, force?: boolean) => tokenProvider.resolve('weixin', userId, force) }
      : {}),
  });

  const syncBufPathOf = (id: string) => join(stateDir, 'openclaw-weixin', 'accounts', `${id}.sync.json`);

  const loadSyncBuf = (): string => {
    try {
      const data = JSON.parse(readFileSync(syncBufPathOf(account.id), 'utf8')) as { get_updates_buf?: string };
      return typeof data.get_updates_buf === 'string' ? data.get_updates_buf : '';
    } catch {
      return '';
    }
  };

  const saveSyncBuf = (buf: string): void => {
    try {
      mkdirSync(join(syncBufPathOf(account.id), '..'), { recursive: true });
      writeFileSync(syncBufPathOf(account.id), JSON.stringify({ get_updates_buf: buf }), 'utf8');
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

    // 该用户的网关凭据：优先用户级 token（ct_），无 provider 时回退全局静态 token
    const resolveBearer = async (force: boolean): Promise<string> => {
      if (tokenProvider) {
        const t = await tokenProvider.resolve('weixin', from, force).catch((err) => {
          errLog('[bot] 解析用户 token 失败，回退静态 token:', err instanceof Error ? err.message : err);
          return '';
        });
        if (t) return t;
      }
      return gatewayToken;
    };

    const send = async (chunk: string) => {
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
    };

    const runOnce = async (forceToken: boolean) => {
      const bearer = await resolveBearer(forceToken);
      return runChatSession({
        gatewayUrl,
        model,
        channel: 'weixin',
        userId: from,
        ownerUsername: account.id,
        message: text,
        ...(bearer ? { gatewayToken: bearer } : {}),
        // 命令：网关本地解析回文本；普通消息：按激活任务路由（agent/task 透传）
        ...(!isCmd && route ? { agent: route.agent, task: route.task } : {}),
        send,
        split: (t) => splitChunks(t, MAX_MSG_LEN),
        // 快速返回：正文累计达到 512 字符即中断请求，用户只收到前 512 字符
        maxTextChars: 512,
        log,
      });
    };

    let out;
    try {
      out = await runOnce(false);
    } catch (err) {
      // 用户级 token 被吊销/轮换（401）：强制刷新一次后重试；仍失败则由 runChatSession 推 ⚠️
      if (err instanceof GatewayUnauthorizedError && tokenProvider) {
        log(`[bot] 用户 token 401，刷新后重试 from=${from}`);
        out = await runOnce(true);
      } else {
        throw err;
      }
    }
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

    const applyDiskToken = (): boolean => {
      try {
        const fresh = loadLatestWeixinAccount(stateDir, preferredAccountId);
        if (fresh.token === account.token && fresh.baseUrl === account.baseUrl) return false;
        account.id = fresh.id;
        account.token = fresh.token;
        account.baseUrl = fresh.baseUrl;
        account.userId = fresh.userId;
        account.savedAt = fresh.savedAt;
        buf = '';
        consecutiveFailures = 0;
        log(`[bot] 已从磁盘热更新微信 token（账号 ${fresh.id}），继续收消息`);
        return true;
      } catch {
        return false;
      }
    };

    while (!signal.aborted) {
      applyDiskToken();
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
        if (isIlinkSessionExpired(resp)) {
          if (applyDiskToken()) continue;
          errLog(
            `[bot] 微信登录态已过期（errcode=${resp.errcode} ${resp.errmsg ?? ''}）。请到管理后台「微信」重新扫码，扫码成功后无需重启即可自动恢复。`,
          );
          await sleep(SESSION_EXPIRED_DELAY_MS, signal);
          consecutiveFailures = 0;
          continue;
        }
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
  if (!existsSync(syncBufPathOf(account.id))) log('[bot] 无历史游标，全新开始收消息');
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
// 独立运行入口：tsx src/channels/weixin-bot.ts；dist 打包为 server/weixin.mjs。
// 注意：esbuild 打包后所有模块共享同一 import.meta.url，不能用 URL 比较；
// 网关内由 gateway/index.ts 以库方式调用 startWeixinBot，bundle 中 argv[1]=gateway.mjs 不匹配此守卫。
// 文件名同时兼容源码 weixin-bot.ts 与 dist 产物 weixin.mjs。
if (process.argv[1] && /(^|[\\/])(weixin-bot|weixin)\.(ts|mjs|js|cjs)$/.test(process.argv[1])) {
  const consoleLog = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
  const consoleErr = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

  // 独立进程：读三进程共享配置的 weixin 段（env 优先级最高，配置段其次，再由 gateway 段推导）
  const { config } = loadSharedConfig();
  const runtime = resolveChildRuntime(
    config,
    { gatewayUrl: config.weixin.gatewayUrl, gatewayToken: config.weixin.gatewayToken },
    { url: process.env.LINKAGENT_GATEWAY_URL, token: process.env.LINKAGENT_GATEWAY_TOKEN },
  );
  const model = process.env.LINKAGENT_GATEWAY_MODEL ?? config.weixin.model ?? 'agent:pi';
  const accountId = process.env.LINKAGENT_ACCOUNT_ID ?? config.weixin.accountId ?? undefined;

  startWeixinBot({
    gatewayUrl: runtime.gatewayUrl,
    ...(runtime.gatewayToken ? { gatewayToken: runtime.gatewayToken } : {}),
    model,
    ...(accountId ? { accountId } : {}),
    log: consoleLog,
    errLog: consoleErr,
  })
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
