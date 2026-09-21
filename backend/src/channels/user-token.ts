/**
 * 渠道用户级 token 解析（bot 侧）。
 *
 * 微信 bot 不再长期持全局静态 token 代表所有用户，而是按「每个微信用户」解析一枚用户级 token：
 *   - 内嵌模式（bot 与网关同进程）：网关直接把签发函数注入进来，无需任何 HTTP 引导；
 *   - external 独立进程模式：bot 持静态 token 调 POST /api/bot/channel-token 换取（首次/失效时）。
 *
 * 解析结果做「内存 + 落盘」两级缓存（<stateDir>/openclaw-weixin/accounts/user-tokens.json），
 * 进程重启不重复换取；网关返回 401（token 被吊销/轮换）时由 force=true 强制重新解析。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 按渠道用户解析其用户级 token；force=true 时跳过缓存强制重新签发/换取 */
export interface UserTokenProvider {
  resolve(channel: string, userId: string, force?: boolean): Promise<string>;
}

function tokenCacheKey(channel: string, userId: string): string {
  return `${channel}:${userId}`;
}

/**
 * 内嵌模式：网关把 ChannelTokenStore.ensure 包成同步签发函数注入。
 * 落盘缓存主要为统一接口形态（同进程本可直接读 store），也便于 bot 重启后行为一致。
 */
export class InProcessUserTokenProvider implements UserTokenProvider {
  private readonly cache = new Map<string, string>();

  constructor(private readonly issue: (channel: string, userId: string) => string) {}

  async resolve(channel: string, userId: string, force = false): Promise<string> {
    const key = tokenCacheKey(channel, userId);
    if (!force) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }
    const token = this.issue(channel, userId);
    this.cache.set(key, token);
    return token;
  }
}

/** external 独立进程模式：经网关引导接口用静态 token 换取用户级 token，落盘缓存。 */
export class HttpUserTokenProvider implements UserTokenProvider {
  private readonly cache = new Map<string, string>();
  private readonly cachePath: string;

  constructor(
    private readonly opts: {
      gatewayUrl: string;
      /** 网关静态 token（仅用于引导换取，换取后对话只带用户级 token） */
      gatewayToken: string;
      stateDir: string;
      accountId: string;
      log?: (...args: unknown[]) => void;
    },
  ) {
    this.cachePath = join(opts.stateDir, 'openclaw-weixin', 'accounts', `${opts.accountId}.user-tokens.json`);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.cachePath)) return;
      const data = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string' && v) this.cache.set(k, v);
    } catch {
      /* 缓存损坏不影响运行 */
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.cachePath, '..'), { recursive: true });
      const data: Record<string, string> = {};
      for (const [k, v] of this.cache) data[k] = v;
      writeFileSync(this.cachePath, JSON.stringify(data), 'utf8');
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  async resolve(channel: string, userId: string, force = false): Promise<string> {
    const key = tokenCacheKey(channel, userId);
    if (!force) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }
    const url = `${this.opts.gatewayUrl.replace(/\/$/, '')}/api/bot/channel-token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.opts.gatewayToken ? { Authorization: `Bearer ${this.opts.gatewayToken}` } : {}),
      },
      body: JSON.stringify({ channel, userId, ownerUsername: this.opts.accountId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`换取用户 token 失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error('换取用户 token 失败：响应缺少 token');
    this.cache.set(key, data.token);
    this.persist();
    this.opts.log?.(`[token] 已为 ${channel}:${userId} 解析用户级 token${force ? '（强制刷新）' : ''}`);
    return data.token;
  }
}
