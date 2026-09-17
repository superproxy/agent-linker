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
   * 获取某渠道用户的现有 token；没有则签发一枚（幂等：同一用户长期复用一枚，
   * 与「长期有效 + 可手动吊销/轮换」的策略一致）。
   */
  ensure(channel: string, userId: string, label?: string): ChannelTokenRecord {
    const existing = this.find(channel, userId);
    if (existing) return existing;
    return this.issue(channel, userId, label);
  }

  /** 强制为某渠道用户签发一枚新 token（不影响旧 token；调用方可随后 revoke 旧的实现轮换） */
  issue(channel: string, userId: string, label?: string): ChannelTokenRecord {
    const ch = channel.trim();
    const uid = userId.trim();
    if (!ch || !uid) throw new Error('channel 与 userId 必填');
    const record: ChannelTokenRecord = {
      token: newChannelToken(),
      channel: ch,
      userId: uid,
      ...(label?.trim() ? { label: label.trim() } : {}),
      createdAt: new Date().toISOString(),
    };
    this.kv.put(record.token, record);
    return record;
  }

  /** 查到某渠道用户的唯一（最新）token 记录；无则 null */
  find(channel: string, userId: string): ChannelTokenRecord | null {
    const all = this.kv.list().filter((r) => r.channel === channel && r.userId === userId);
    if (all.length === 0) return null;
    // 理论上一个用户只有一枚（ensure 幂等）；多枚时取最近创建
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

  /** 删除某渠道用户的全部 token（删除用户时级联清理） */
  revokeForUser(channel: string, userId: string): void {
    for (const r of this.kv.list()) {
      if (r.channel === channel && r.userId === userId) this.kv.delete(r.token);
    }
  }
}
