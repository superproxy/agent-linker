/**
 * 个人微信扫码登录服务 + 管理 API（web 后台集成，替代 CLI weixin-login）
 *
 * 流程（与 dev/weixin-login.ts 同源，复用 openclaw-weixin 插件官方扫码机制）：
 *   1. import @tencent-weixin/openclaw-weixin，模拟 register() 提取 channel 插件
 *   2. loginWithQrStart() → qrDataUrl（登录链接内容）+ sessionKey
 *   3. 后端把链接内容渲染成二维码 PNG data URL（qrcode）→ web 后台 <img> 展示
 *   4. 前端轮询 loginWithQrWait() 直到 connected
 *   5. 插件自动把 bot_token + ilink_bot_id 写入 accounts/；可选 POST /api/weixin/reload 热重启 adapter
 */
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getLayout } from '../install/layout.js';
import { notifyBotStop } from '../channels/ilink-client.js';
import {
  assertWeixinUsername,
  claimWeixinBinding,
  listWeixinBindings,
  readWeixinBinding,
  removeWeixinBinding,
  type ClaimBindingResult,
  type WeixinUserBinding,
} from '../channels/weixin-binding.js';

interface LoginGatewayHandle {
  loginWithQrStart(params: { accountId?: string; force?: boolean; verbose?: boolean }): Promise<{
    qrDataUrl?: string;
    message?: string;
    sessionKey?: string;
  }>;
  loginWithQrWait(params: { sessionKey?: string; accountId?: string; timeoutMs?: number }): Promise<{
    connected?: boolean;
    message?: string;
    accountId?: string;
  }>;
}

interface WeixinChannelPlugin {
  id?: string;
  gateway: LoginGatewayHandle;
}

export interface WeixinAccountInfo {
  id: string;
  userId?: string;
  savedAt?: string;
  /** 该登录用户指向的机器人文件 id（*-im-bot），不是另一份登录态副本 */
  botAccountId?: string;
}

export interface WeixinStatus {
  configured: boolean;
  accounts: WeixinAccountInfo[];
  /** 登录用户 → 机器人文件。页面按这个判断是否已绑定，不按 accounts/ 里有没有 <用户名>.json */
  bindings: WeixinUserBinding[];
  activeAccountId?: string;
  /** 当前登录用户对应的微信账号槽（与进程 weixin:<id> 一致） */
  bindAccountId?: string;
  processId?: string;
  processRunning?: boolean;
}

export type AuthCheck = (request: { headers: Record<string, string | string[] | undefined> }) => boolean;

/** 扫码状态（前端轮询） */
export interface QrWaitResult {
  connected: boolean;
  /**
   * 微信 bot 已绑定（binded_redirect）且本机已有 token。
   * 插件文案写成 OpenClaw，实际是 ilink bot，收发走 weixin-bot，不经过 OpenClaw。
   */
  alreadyBound?: boolean;
  accountId?: string;
  message?: string;
}

/** 插件把 binded_redirect 写成「已连接过此 OpenClaw」。那是 bot 已绑定、不再下发 token，不是 OpenClaw 渠道。 */
export function isWeixinBotAlreadyBoundMessage(message?: string): boolean {
  return /无需重复连接|已连接过|binded_redirect/.test(message ?? '');
}

/**
 * 插件 connected=false 时的两种结果：
 * - 本机已把机器人登录态绑到该账号槽：沿用并拉起 weixin-bot；
 * - 没有可绑定的登录文件：不能当成成功。微信不再发 token，手机里仍显示已连接时才需要先退出。
 */
export function normalizeQrWait(
  wait: {
    connected?: boolean;
    accountId?: string;
    message?: string;
  },
  opts?: { hasLocalToken?: boolean },
): QrWaitResult {
  const reuse = wait.connected !== true && isWeixinBotAlreadyBoundMessage(wait.message);
  if (reuse && opts?.hasLocalToken) {
    return {
      connected: true,
      alreadyBound: true,
      ...(wait.accountId ? { accountId: wait.accountId } : {}),
      message: '这个微信机器人已经绑定过，沿用本机登录态。收发由 weixin-bot 直连，不经过 OpenClaw。',
    };
  }
  if (reuse) {
    return {
      connected: false,
      ...(wait.accountId ? { accountId: wait.accountId } : {}),
      message:
        '微信没有下发新登录态，本机也没有可绑到该账号的机器人登录文件。当前渠道是 weixin-bot。若手机里仍显示已连接，需要先退出该机器人再扫。',
    };
  }
  return {
    connected: wait.connected === true,
    ...(wait.accountId ? { accountId: wait.accountId } : {}),
    message: wait.message,
  };
}

const qrRefreshListeners = new Set<(text: string) => void>();
let stdoutTapInstalled = false;

/** 从插件 stdout 里取出刷新后的二维码链接。armed 跨多次 write 保持，直到看到 URL。 */
export function takeRefreshedQrUrl(text: string, state: { armed: boolean }): string | undefined {
  if (text.includes('二维码已更新') || text.includes('请重新扫描')) state.armed = true;
  if (!state.armed) return undefined;
  const matched = text.match(/https?:\/\/\S+/);
  const url = matched?.[0]?.replace(/[)\].,]+$/, '');
  if (!url) return undefined;
  state.armed = false;
  return url;
}

/** 插件刷新二维码时把新链接写到 stdout，这里摘出来给页面换图 */
function ensureQrStdoutTap(): void {
  if (stdoutTapInstalled) return;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    if (text) {
      for (const fn of qrRefreshListeners) fn(text);
    }
    if (typeof encoding === 'function') return orig(chunk, encoding);
    if (cb) return orig(chunk, encoding, cb);
    if (encoding) return orig(chunk, encoding);
    return orig(chunk);
  }) as typeof process.stdout.write;
  stdoutTapInstalled = true;
}

function watchQrRefresh(onUrl: (url: string) => void): () => void {
  ensureQrStdoutTap();
  const state = { armed: false };
  const onText = (text: string) => {
    const url = takeRefreshedQrUrl(text, state);
    if (url) onUrl(url);
  };
  qrRefreshListeners.add(onText);
  return () => {
    qrRefreshListeners.delete(onText);
  };
}

export interface WeixinLoginDeps {
  /** weixin-bot adapter 热重启句柄（weixin.mode=weixin-bot 时可用） */
  reloadBot?: () => Promise<void>;
  /** 无内嵌 adapter（external/插件模式）时 reload 接口返回的提示文案 */
  reloadUnavailableMessage?: string;
  log?: (...args: unknown[]) => void;
  isAdmin?: AuthCheck;
  sessionUser?: (request: FastifyRequest) => { username: string } | null;
  /** 扫码成功后登记账号并拉起 weixin:<accountId> 进程 */
  onBound?: (accountId: string) => void | Promise<void>;
  /** 重启该用户的微信进程（优先于内嵌 reloadBot） */
  restartAccount?: (accountId: string) => void | Promise<void>;
  /** 取消绑定后停进程并从 weixin.accounts 移除 */
  onUnbound?: (accountId: string) => void | Promise<void>;
  isProcessRunning?: (accountId: string) => boolean;
}

export class WeixinLoginService {
  private readonly stateDir: string;
  private readonly log: (...args: unknown[]) => void;
  private channelHandle: WeixinChannelPlugin | null = null;
  /** 等待扫码期间插件刷新出来的新二维码内容（sessionKey → url） */
  private readonly liveQr = new Map<string, string>();

  constructor(deps: { stateDir?: string; log?: (...args: unknown[]) => void } = {}) {
    this.stateDir = deps.stateDir ?? getLayout().pluginsState;
    this.log = deps.log ?? (() => {});
  }

  private accountsDir(): string {
    return join(this.stateDir, 'openclaw-weixin', 'accounts');
  }

  /** 磁盘上的机器人登录文件 + 绑定表。configured 只看绑定能否对上一个带 token 的 *-im-bot 文件。 */
  status(): WeixinStatus {
    const accounts = this.readAccountFiles().map((a) => ({ id: a.id, userId: '', savedAt: a.savedAt }));
    const dir = this.accountsDir();
    if (existsSync(dir)) {
      for (const account of accounts) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, `${account.id}.json`), 'utf8')) as { userId?: string };
          if (typeof raw.userId === 'string') account.userId = raw.userId;
        } catch {
          /* userId 缺失不影响绑定判断 */
        }
      }
    }
    const bindings = listWeixinBindings(this.stateDir);
    const live = bindings.filter((b) => accounts.some((a) => a.id === b.botAccountId));
    return {
      configured: live.length > 0,
      accounts,
      bindings,
      activeAccountId: live[0]?.botAccountId,
    };
  }

  /** 该登录用户是否已指向一份仍在磁盘上的机器人登录态 */
  hasToken(accountId: string): boolean {
    const id = accountId.trim();
    if (!id) return false;
    const binding = readWeixinBinding(this.stateDir, id);
    if (!binding) return false;
    return this.readAccountFiles().some((a) => a.id === binding.botAccountId);
  }

  /**
   * 扫码确认后把登录用户指向插件写下的机器人文件。不复制 json。
   * 返回 taken 表示这个机器人已经属于别的登录用户。
   */
  claimBinding(username: string, pluginAccountId: string): ClaimBindingResult {
    return claimWeixinBinding(this.stateDir, username, pluginAccountId);
  }

  /**
   * 微信不再下发新 token 时，把当前用户指向尚未被其他用户占用、savedAt 最新的 *-im-bot。
   * 只写绑定，不复制文件。这是用户正在扫码，不是进程启动时借用。
   */
  bindNewestUnclaimed(username: string): boolean {
    const user = username.trim();
    if (!user || !/^[A-Za-z0-9._-]+$/.test(user)) return false;
    if (this.hasToken(user)) return true;
    const taken = new Set(
      listWeixinBindings(this.stateDir)
        .filter((b) => b.username !== user)
        .map((b) => b.botAccountId),
    );
    const plugins = this.readAccountFiles().filter((a) => a.id.endsWith('-im-bot') && !taken.has(a.id));
    if (plugins.length === 0) return false;
    const newest = plugins.reduce((best, a) => (a.savedAt >= best.savedAt ? a : best));
    return this.claimBinding(user, newest.id) === 'ok';
  }

  /**
   * 取消绑定：去掉该登录用户的指向，并删掉旧逻辑留下的 <用户名>.json 副本。
   * 插件写下的 *-im-bot.json 留在磁盘上，但没有绑定就不会被任何进程使用。
   * 通知停止只用这份绑定指向的机器人 token。
   */
  unbind(accountId: string): { accountId: string; removed: string[]; sessions: { baseUrl: string; token: string }[] } {
    const id = this.assertAccountId(accountId);
    const binding = removeWeixinBinding(this.stateDir, id);
    const accounts = this.readAccountFiles();
    const sessions: { baseUrl: string; token: string }[] = [];
    const boundBot = binding ? accounts.find((a) => a.id === binding.botAccountId) : undefined;
    if (boundBot?.token) sessions.push({ baseUrl: boundBot.baseUrl, token: boundBot.token });
    const names = [`${id}.json`, `${id}.sync.json`, `${id}.context-tokens.json`, `${id}.user-tokens.json`];
    if (binding) {
      names.push(`${binding.botAccountId}.context-tokens.json`, `${binding.botAccountId}.user-tokens.json`);
    }
    const removed = this.removeAccountFiles(id, names);
    if (binding) removed.push(`binding:${id}`);
    return { accountId: id, removed, sessions };
  }

  private readAccountFiles(): { id: string; token: string; baseUrl: string; savedAt: string }[] {
    const dir = this.accountsDir();
    if (!existsSync(dir)) return [];
    const out: { id: string; token: string; baseUrl: string; savedAt: string }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'accounts.json' || f.includes('context-tokens') || f.includes('user-tokens') || f.endsWith('.sync.json')) {
        continue;
      }
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { token?: string; baseUrl?: string; savedAt?: string };
        if (typeof raw.token !== 'string' || !raw.token) continue;
        out.push({
          id: f.replace(/\.json$/, ''),
          token: raw.token,
          baseUrl: raw.baseUrl ?? '',
          savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
        });
      } catch {
        /* 跳过坏文件 */
      }
    }
    return out;
  }

  /**
   * 重新绑定时清该用户的 ct_ 缓存，以及它当前指向的机器人上下文缓存。
   * 不扫掉目录里其他用户的 *-tokens。
   */
  clearChannelTokenCache(accountId: string): { accountId: string; removed: string[] } {
    const id = this.assertAccountId(accountId);
    const binding = readWeixinBinding(this.stateDir, id);
    const names = new Set<string>([`${id}.context-tokens.json`, `${id}.user-tokens.json`]);
    if (binding) {
      names.add(`${binding.botAccountId}.context-tokens.json`);
      names.add(`${binding.botAccountId}.user-tokens.json`);
    }
    return { accountId: id, removed: this.removeAccountFiles(id, [...names]) };
  }

  private assertAccountId(accountId: string): string {
    return assertWeixinUsername(accountId);
  }

  private removeAccountFiles(id: string, names: string[]): string[] {
    const dir = this.accountsDir();
    const removed: string[] = [];
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      removed.push(name);
    }
    return removed;
  }

  /** 懒加载 openclaw-weixin channel 插件（模拟 register 提取 gateway.loginWithQr*） */
  private async handle(): Promise<WeixinChannelPlugin> {
    if (this.channelHandle) return this.channelHandle;
    process.env.OPENCLAW_STATE_DIR = this.stateDir;
    const mod = (await import('@tencent-weixin/openclaw-weixin/dist/index.js')) as { default?: unknown };
    const plugin = mod.default as { register(api: unknown): void };
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error('openclaw-weixin 插件无 register() 入口');
    }
    let weixinChannel: WeixinChannelPlugin | null = null;
    const stubApi = {
      version: '2026.9.3-linkagent',
      registerChannel(registration: { plugin?: WeixinChannelPlugin; id?: string }): void {
        const p = registration.plugin ?? (registration as unknown as WeixinChannelPlugin);
        if (p && typeof p.gateway?.loginWithQrStart === 'function') weixinChannel = p;
      },
      registerHttpRoute() {},
      registerTool() {},
      on() {},
      config: {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: { version: '2026.9.3-linkagent', channel: {} },
    };
    plugin.register(stubApi);
    if (!weixinChannel) throw new Error('未提取到 openclaw-weixin channel 插件（registerChannel 未回调）');
    this.channelHandle = weixinChannel;
    return weixinChannel;
  }

  /**
   * 发起扫码。accountId 是登录用户名，只做校验，不传给插件。
   * 插件自己把 token 写成 *-im-bot.json，绑定由扫码结果另记。
   */
  async startQr(force = true, accountId?: string): Promise<{ sessionKey?: string; qrContent: string }> {
    if (accountId) this.assertAccountId(accountId);
    const h = await this.handle();
    const start = await h.gateway.loginWithQrStart({ force, verbose: false });
    if (!start.qrDataUrl) {
      throw new Error(`获取二维码失败：${start.message ?? '未知错误'}`);
    }
    return { sessionKey: start.sessionKey, qrContent: start.qrDataUrl };
  }

  /** 轮询扫码结果。accountId 不传给插件，避免插件按登录用户名另写一份登录态。 */
  async waitQr(sessionKey?: string, timeoutMs = 8_000, accountId?: string): Promise<QrWaitResult> {
    if (accountId) this.assertAccountId(accountId);
    const h = await this.handle();
    const stopWatch = sessionKey
      ? watchQrRefresh((url) => {
          this.liveQr.set(sessionKey, url);
        })
      : undefined;
    try {
      const wait = await h.gateway.loginWithQrWait({ sessionKey, timeoutMs });
      return {
        connected: wait.connected === true,
        accountId: wait.accountId,
        message: wait.message,
      };
    } finally {
      stopWatch?.();
    }
  }

  /** 插件在二维码过期时会换新链接并写到 stdout，页面据此换成新图 */
  peekLiveQr(sessionKey: string): string | undefined {
    return this.liveQr.get(sessionKey);
  }
}

/** 生成二维码 PNG data URL（qrcode 包懒加载，未安装时抛错由调用方提示） */
export async function qrDataUrlOf(content: string): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toDataURL(content, { margin: 1, width: 256 });
}

/**
 * 微信登录管理 API（web 后台集成）：
 *  - GET  /api/weixin/status          当前登录态（普通用户只看自己的账号槽）
 *  - POST /api/weixin/qr              发起扫码登录 → { sessionKey, qrContent, qrDataUrl(PNG) }
 *  - GET  /api/weixin/qr/status      轮询扫码结果（loginWithQrWait，阻塞至确认/超时）
 *  - POST /api/weixin/reload          重启该用户的 weixin:<id> 进程或内嵌 adapter
 *  - POST /api/weixin/unbind          取消绑定（删登录态、停 weixin:<id>）
 */
export function registerWeixinApi(
  app: FastifyInstance,
  service: WeixinLoginService,
  checkAuth: AuthCheck,
  deps: WeixinLoginDeps = {},
): void {
  const isAdmin = deps.isAdmin ?? checkAuth;
  const requireAuth = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!checkAuth(request)) {
      void reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  };

  /** 普通用户强制本人用户名；管理员可用 body/query 指定；无会话且非管理员 → null */
  const resolveAccountId = (request: FastifyRequest, requested?: string): string | null | undefined => {
    const user = deps.sessionUser?.(request);
    const admin = isAdmin(request);
    const want = requested?.trim() || undefined;
    if (user) return admin ? want ?? user.username : user.username;
    if (admin) return want;
    return null;
  };

  const scopedStatus = (request: FastifyRequest) => {
    const full = service.status();
    const user = deps.sessionUser?.(request);
    const admin = isAdmin(request);
    if (!user && !admin) return null;
    const savedPlugins = full.accounts.filter((a) => a.id.endsWith('-im-bot'));
    const bindings = full.bindings ?? [];
    const slotFor = (username: string): WeixinAccountInfo | undefined => {
      const binding = bindings.find((b) => b.username === username);
      if (!binding) return undefined;
      const bot = full.accounts.find((a) => a.id === binding.botAccountId);
      if (!bot) return undefined;
      return { id: username, userId: bot.userId, savedAt: bot.savedAt, botAccountId: bot.id };
    };
    const bindId = user?.username;
    if (!bindId) {
      const slots = bindings.flatMap((b) => {
        const slot = slotFor(b.username);
        return slot ? [slot] : [];
      });
      return {
        configured: slots.length > 0,
        accounts: slots,
        savedPlugins,
        activeAccountId: slots[0]?.botAccountId,
      };
    }
    const mine = slotFor(bindId);
    return {
      configured: mine !== undefined,
      accounts: mine ? [mine] : [],
      savedPlugins,
      activeAccountId: mine?.botAccountId,
      bindAccountId: bindId,
      processId: `weixin:${bindId}`,
      processRunning: deps.isProcessRunning?.(bindId) === true,
    };
  };

  app.get('/api/weixin/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const body = scopedStatus(request);
    if (!body) return reply.code(403).send({ error: 'forbidden' });
    return body;
  });

  app.post('/api/weixin/qr', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { force?: boolean; accountId?: string };
    const accountId = resolveAccountId(request, body.accountId);
    if (accountId === null) return reply.code(403).send({ error: 'forbidden' });
    try {
      const { sessionKey, qrContent } = await service.startQr(body.force !== false, accountId);
      let qrDataUrl: string | undefined;
      try {
        qrDataUrl = await qrDataUrlOf(qrContent);
      } catch {
        /* qrcode 未安装：仅回链接内容，前端可提示 */
      }
      return { sessionKey, qrContent, qrDataUrl, accountId };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/weixin/qr/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const q = request.query as { sessionKey?: string; timeoutMs?: string; accountId?: string };
    const accountId = resolveAccountId(request, q.accountId);
    if (accountId === null) return reply.code(403).send({ error: 'forbidden' });
    try {
      const timeoutMs = Math.min(Number(q.timeoutMs) || 8_000, 180_000);
      const raw = await service.waitQr(q.sessionKey, timeoutMs, accountId);
      let hasLocalToken = accountId ? service.hasToken(accountId) : false;
      if (!hasLocalToken && accountId && isWeixinBotAlreadyBoundMessage(raw.message)) {
        hasLocalToken = service.bindNewestUnclaimed(accountId);
      }
      const wait = normalizeQrWait(raw, { hasLocalToken });
      if (wait.connected && accountId) {
        if (wait.accountId) {
          const claim = service.claimBinding(accountId, wait.accountId);
          if (claim === 'taken') {
            return {
              connected: false,
              accountId,
              message: '这个微信已经绑在其他登录用户上。一个登录用户只对应一个微信，一个微信也只对应一个登录用户。',
            };
          }
          if (claim === 'missing') {
            return {
              connected: false,
              accountId,
              message: '扫码已确认，但本机还没有对应的机器人登录文件。请稍等插件落盘后再试，或重新发起扫码。',
            };
          }
        }
        if (!service.hasToken(accountId)) service.bindNewestUnclaimed(accountId);
        if (!service.hasToken(accountId)) {
          return {
            connected: false,
            accountId,
            message: '扫码已确认，但没有把机器人登录文件绑到当前登录用户。请确认本机有尚未被其他用户占用的机器人登录文件。',
          };
        }
        let boundWarning: string | undefined;
        try {
          await deps.onBound?.(accountId);
        } catch (err) {
          boundWarning = `登录态已保存，但拉起微信进程失败：${err instanceof Error ? err.message : String(err)}`;
          deps.log?.(boundWarning);
        }
        return { ...wait, accountId, ...(boundWarning ? { boundWarning } : {}) };
      }
      return wait;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.(`weixin qr status 失败：${message}`);
      // 轮询失败不要 500：前端会当成扫码中断；未确认时继续等下一次
      return { connected: false, message };
    }
  });

  app.get('/api/weixin/qr/current', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const q = request.query as { sessionKey?: string };
    const sessionKey = q.sessionKey?.trim();
    if (!sessionKey) return { qrContent: null };
    const qrContent = service.peekLiveQr(sessionKey);
    if (!qrContent) return { qrContent: null };
    let qrDataUrl: string | undefined;
    try {
      qrDataUrl = await qrDataUrlOf(qrContent);
    } catch {
      /* 无 qrcode 包时只回链接 */
    }
    return { qrContent, ...(qrDataUrl ? { qrDataUrl } : {}) };
  });

  app.post('/api/weixin/reload', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { accountId?: string };
    const accountId = resolveAccountId(request, body.accountId);
    if (accountId === null) return reply.code(403).send({ error: 'forbidden' });
    try {
      if (accountId && deps.restartAccount) {
        await deps.restartAccount(accountId);
        return { ok: true, processId: `weixin:${accountId}` };
      }
      if (!deps.reloadBot) {
        return reply
          .code(400)
          .send({ error: deps.reloadUnavailableMessage ?? '当前模式无 weixin-bot adapter，不支持热重启' });
      }
      await deps.reloadBot();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/weixin/unbind', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { accountId?: string };
    const accountId = resolveAccountId(request, body.accountId);
    if (accountId === null) return reply.code(403).send({ error: 'forbidden' });
    if (!accountId) return reply.code(400).send({ error: '账号槽必填' });
    try {
      const result = service.unbind(accountId);
      for (const session of result.sessions ?? []) {
        try {
          await notifyBotStop(session);
        } catch (err) {
          deps.log?.(`微信 notifyStop 失败（本地登录态已删除）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        await deps.onUnbound?.(accountId);
      } catch (err) {
        return reply.code(500).send({
          error: `登录态已清除，但停止微信进程失败：${err instanceof Error ? err.message : String(err)}`,
          accountId,
          removed: result.removed,
        });
      }
      return { ok: true, accountId, removed: result.removed };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
