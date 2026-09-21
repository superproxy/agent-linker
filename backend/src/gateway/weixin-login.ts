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
import { loadWeixinAccount } from '../channels/ilink-client.js';

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
}

export interface WeixinStatus {
  configured: boolean;
  accounts: WeixinAccountInfo[];
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
  accountId?: string;
  message?: string;
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

  constructor(deps: { stateDir?: string; log?: (...args: unknown[]) => void } = {}) {
    this.stateDir = deps.stateDir ?? getLayout().pluginsState;
    this.log = deps.log ?? (() => {});
  }

  private accountsDir(): string {
    return join(this.stateDir, 'openclaw-weixin', 'accounts');
  }

  /** 当前登录态：扫描 accounts/ 下含 token 的账号文件 */
  status(): WeixinStatus {
    const dir = this.accountsDir();
    if (!existsSync(dir)) return { configured: false, accounts: [] };
    const accounts: WeixinAccountInfo[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'accounts.json' && !x.includes('context-tokens'))) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { token?: string; userId?: string; savedAt?: string };
        if (typeof raw.token !== 'string' || !raw.token) continue;
        accounts.push({ id: f.replace(/\.json$/, ''), userId: raw.userId ?? '', savedAt: raw.savedAt ?? '' });
      } catch {
        /* 单个文件损坏不影响扫描 */
      }
    }
    let activeAccountId: string | undefined;
    try {
      activeAccountId = loadWeixinAccount(dir).id;
    } catch {
      /* 无可用账号 */
    }
    return { configured: accounts.length > 0, accounts, activeAccountId };
  }

  /**
   * 取消绑定：删除该账号槽的登录态及附属文件（sync / context-tokens / user-tokens）。
   * 不存在的文件视为已解绑（幂等）。
   */
  unbind(accountId: string): { accountId: string; removed: string[] } {
    const id = accountId.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`非法微信账号槽: ${accountId}`);
    const dir = this.accountsDir();
    const names = [`${id}.json`, `${id}.sync.json`, `${id}.context-tokens.json`, `${id}.user-tokens.json`];
    const removed: string[] = [];
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      removed.push(name);
    }
    return { accountId: id, removed };
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

  /** 发起扫码登录：返回登录链接内容 + sessionKey（由调用方渲染二维码）；accountId 指定回写的账号文件 */
  async startQr(force = true, accountId?: string): Promise<{ sessionKey?: string; qrContent: string }> {
    const h = await this.handle();
    const start = await h.gateway.loginWithQrStart({
      force,
      verbose: false,
      ...(accountId ? { accountId } : {}),
    });
    if (!start.qrDataUrl) {
      throw new Error(`获取二维码失败：${start.message ?? '未知错误'}`);
    }
    return { sessionKey: start.sessionKey, qrContent: start.qrDataUrl };
  }

  /** 轮询扫码结果（阻塞到确认或超时）；accountId 需与 startQr 一致，确保回写目标账号 */
  async waitQr(sessionKey?: string, timeoutMs = 8_000, accountId?: string): Promise<QrWaitResult> {
    const h = await this.handle();
    const wait = await h.gateway.loginWithQrWait({
      sessionKey,
      timeoutMs,
      ...(accountId ? { accountId } : {}),
    });
    return {
      connected: wait.connected === true,
      accountId: wait.accountId,
      message: wait.message,
    };
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
    if (admin) {
      const own = user?.username;
      return {
        ...full,
        ...(own
          ? {
              bindAccountId: own,
              processId: `weixin:${own}`,
              processRunning: deps.isProcessRunning?.(own) === true,
            }
          : {}),
      };
    }
    const bindId = user!.username;
    const accounts = full.accounts.filter((a) => a.id === bindId);
    return {
      configured: accounts.length > 0,
      accounts,
      activeAccountId: accounts[0]?.id,
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
      const timeoutMs = Math.min(Number(q.timeoutMs) || 8_000, 30_000);
      const wait = await service.waitQr(q.sessionKey, timeoutMs, accountId);
      if (wait.connected) {
        const boundId = wait.accountId || accountId;
        if (boundId) {
          try {
            await deps.onBound?.(boundId);
          } catch (err) {
            return reply.code(500).send({
              error: `绑定成功但拉起微信进程失败：${err instanceof Error ? err.message : String(err)}`,
              connected: true,
              accountId: boundId,
            });
          }
        }
      }
      return wait;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
