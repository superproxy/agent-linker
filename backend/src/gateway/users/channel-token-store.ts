import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/**
 * 渠道终端用户级凭据（区别于「登录账号」UserStore）：
 *   一个微信用户（channel:userId）持有一枚长期 token，bot 进程代其直连网关，
 *   只能访问 /v1（该用户自己的任务路由）与自己的 GET /api/tasks，不能碰管理接口。
 *
 * 落盘 .runtime-state/users/channel-tokens/<token>.json（复用通用 KV，原子写/损坏隔离）。
 * 以 token 为 KV 键，鉴权时 O(1) 反查；管理列表按 channel/userId 聚合。
 */

/** 渠道用户 token 前缀：与任务 key（k_）、会话 token（裸 hex）区分，便于识别与日志过滤 */
export const CHANNEL_TOKEN_PREFIX = 'ct_';
const CHANNEL_TOKEN_BYTES = 32;

export interface ChannelTokenRecord {
  /** 凭据本体（ct_<64 hex>），同时作为 KV 键 */
  token: string;
  /** 渠道标识（目前仅 weixin） */
  channel: string;
  /** 渠道内用户 id（微信 from_user_id） */
  userId: string;
  /** 登录用户微信账号槽（weixin:<id>）；缺省为旧数据 */
  ownerUsername?: string;
  /** 备注名（可选，管理后台展示） */
  label?: string;
  createdAt: string;
  /** 最近一次被网关鉴权使用的时间（可选，后台展示/审计） */
  lastUsedAt?: string;
}

export function newChannelToken(): string {
  return `${CHANNEL_TOKEN_PREFIX}${randomBytes(CHANNEL_TOKEN_BYTES).toString('hex')}`;
}

/** 判断字符串形态是否像渠道用户 token（前缀快速判别，避免无谓 KV 查询） */
export function isChannelTokenShape(value: string): boolean {
  return value.startsWith(CHANNEL_TOKEN_PREFIX);
}

export class ChannelTokenStore {
  private readonly kv: KvJsonStore<ChannelTokenRecord>;

  constructor(stateDir: string) {
    this.kv = createKvJsonStore<ChannelTokenRecord>(join(stateDir, 'channel-tokens'));
  }

  /** 按凭据本体反查记录；无效/已删除返回 null */
  resolve(token: string): ChannelTokenRecord | null {
    const t = token.trim();
    if (!isChannelTokenShape(t)) return null;
    return this.kv.get(t);
  }

  /** 记录最近使用时间（best-effort，失败不影响鉴权） */
  touch(token: string): void {
    const rec = this.kv.get(token);
    if (!rec) return;
    this.kv.put(token, { ...rec, lastUsedAt: new Date().toISOString() });
  }

  /**
   * 获取某渠道用户的现有 token；没有则签发一枚（幂等：同一 owner+用户长期复用一枚）。
   * ownerUsername 有值时只匹配该登录用户的微信槽，避免重新绑定后仍拿到旧凭据。
   */
  ensure(channel: string, userId: string, label?: string, ownerUsername?: string): ChannelTokenRecord {
    const existing = this.find(channel, userId, ownerUsername);
    if (existing) return existing;
    return this.issue(channel, userId, label, ownerUsername);
  }

  /** 强制为某渠道用户签发一枚新 token（不影响旧 token；调用方可随后 revoke 旧的实现轮换） */
  issue(channel: string, userId: string, label?: string, ownerUsername?: string): ChannelTokenRecord {
    const ch = channel.trim();
    const uid = userId.trim();
    if (!ch || !uid) throw new Error('channel 与 userId 必填');
    const owner = ownerUsername?.trim();
    const record: ChannelTokenRecord = {
      token: newChannelToken(),
      channel: ch,
      userId: uid,
      ...(owner ? { ownerUsername: owner } : {}),
      ...(label?.trim() ? { label: label.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    this.kv.put(record.token, record);
    return record;
  }

  /** 查到某渠道用户的 token；指定 owner 时只看该账号槽（不含无归属旧记录） */
  find(channel: string, userId: string, ownerUsername?: string): ChannelTokenRecord | null {
    const owner = ownerUsername?.trim();
    const all = this.kv.list().filter((r) => {
      if (r.channel !== channel || r.userId !== userId) return false;
      if (owner) return r.ownerUsername === owner;
      return true;
    });
    if (all.length === 0) return null;
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return all[0] ?? null;
  }

  /** 列出全部渠道用户 token（管理后台用） */
  list(): ChannelTokenRecord[] {
    return this.kv.list().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 吊销指定凭据 */
  revoke(token: string): void {
    this.kv.delete(token.trim());
  }

  /** 删除某渠道用户的 token；指定 owner 时只删该账号槽 */
  revokeForUser(channel: string, userId: string, ownerUsername?: string): void {
    const owner = ownerUsername?.trim();
    for (const r of this.kv.list()) {
      if (r.channel !== channel || r.userId !== userId) continue;
      if (owner && r.ownerUsername !== owner) continue;
      this.kv.delete(r.token);
    }
  }

  /** 删除某登录用户微信槽下全部渠道凭据（重新绑定 / 取消绑定时吊销旧 ct_） */
  revokeForOwner(channel: string, ownerUsername: string): void {
    const owner = ownerUsername.trim();
    if (!owner) return;
    for (const r of this.kv.list()) {
      if (r.channel === channel && r.ownerUsername === owner) this.kv.delete(r.token);
    }
  }
}
