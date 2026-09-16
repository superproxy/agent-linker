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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { findInstallRoot } from './config.js';
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
}

/** 扫码状态（前端轮询） */
export interface QrWaitResult {
  connected: boolean;
  accountId?: string;
  message?: string;
}

export interface WeixinLoginDeps {
  /** weixin-bot adapter 热重启句柄（weixin.mode=weixin-bot 时可用） */
  reloadBot?: () => Promise<void>;
  log?: (...args: unknown[]) => void;
}

export class WeixinLoginService {
  private readonly stateDir: string;
  private readonly log: (...args: unknown[]) => void;
  private channelHandle: WeixinChannelPlugin | null = null;

  constructor(deps: { stateDir?: string; log?: (...args: unknown[]) => void } = {}) {
    this.stateDir = deps.stateDir ?? join(findInstallRoot(), '.runtime-state', 'plugins');
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
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'accounts.json')) {
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

  /** 发起扫码登录：返回登录链接内容 + sessionKey（由调用方渲染二维码） */
  async startQr(force = true): Promise<{ sessionKey?: string; qrContent: string }> {
    const h = await this.handle();
    const start = await h.gateway.loginWithQrStart({ force, verbose: false });
    if (!start.qrDataUrl) {
      throw new Error(`获取二维码失败：${start.message ?? '未知错误'}`);
    }
    return { sessionKey: start.sessionKey, qrContent: start.qrDataUrl };
  }

  /** 轮询扫码结果（阻塞到确认或超时） */
  async waitQr(sessionKey?: string, timeoutMs = 8_000): Promise<QrWaitResult> {
    const h = await this.handle();
    const wait = await h.gateway.loginWithQrWait({ sessionKey, timeoutMs });
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

export type AuthCheck = (request: { headers: Record<string, string | string[] | undefined> }) => boolean;

/**
 * 微信登录管理 API（web 后台集成）：
 *  - GET  /api/weixin/status          当前登录态（账号列表）
 *  - POST /api/weixin/qr              发起扫码登录 → { sessionKey, qrContent, qrDataUrl(PNG) }
 *  - GET  /api/weixin/qr/status      轮询扫码结果（loginWithQrWait，阻塞至确认/超时）
 *  - POST /api/weixin/reload          扫码登录后热重启 weixin-bot adapter（weixin-bot 模式）
 */
export function registerWeixinApi(
  app: FastifyInstance,
  service: WeixinLoginService,
  checkAuth: AuthCheck,
  deps: WeixinLoginDeps = {},
): void {
  app.get('/api/weixin/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    return service.status();
  });

  app.post('/api/weixin/qr', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    const body = (request.body ?? {}) as { force?: boolean };
    try {
      const { sessionKey, qrContent } = await service.startQr(body.force !== false);
      let qrDataUrl: string | undefined;
      try {
        qrDataUrl = await qrDataUrlOf(qrContent);
      } catch {
        /* qrcode 未安装：仅回链接内容，前端可提示 */
      }
      return { sessionKey, qrContent, qrDataUrl };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/weixin/qr/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    const q = request.query as { sessionKey?: string; timeoutMs?: string };
    try {
      const timeoutMs = Math.min(Number(q.timeoutMs) || 8_000, 30_000);
      return await service.waitQr(q.sessionKey, timeoutMs);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/weixin/reload', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.reloadBot) return reply.code(400).send({ error: '当前模式无 weixin-bot adapter，不支持热重启' });
    try {
      await deps.reloadBot();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
