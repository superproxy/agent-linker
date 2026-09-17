import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/**
 * 登录账号的个人 API token（与「渠道终端用户凭据」channel-token-store 同构）：
 *   一个登录账号（username）持有一枚长期 token，用于 OpenAI 兼容客户端（Chatbox 等）
 *   以 Authorization: Bearer pat_... 直连网关 /v1，权限等同该账号本人。
 *
 * 落盘 .runtime-state/users/personal-tokens/<token>.json（复用通用 KV，原子写/损坏隔离）。
 * 以 token 为 KV 键，鉴权时 O(1) 反查；自助接口按 username 聚合。
 */

/** 个人 API token 前缀：与渠道用户 token（ct_）、任务 key（k_）、会话 token（裸 hex）区分 */
export const PERSONAL_TOKEN_PREFIX = 'pat_';
const PERSONAL_TOKEN_BYTES = 32;

export interface PersonalTokenRecord {
  /** 凭据本体（pat_<64 hex>），同时作为 KV 键 */
  token: string;
  /** 归属登录账号（UserRecord.username） */
  username: string;
  createdAt: string;
  /** 最近一次被网关鉴权使用的时间（可选，展示/审计） */
  lastUsedAt?: string;
}

export function newPersonalToken(): string {
  return `${PERSONAL_TOKEN_PREFIX}${randomBytes(PERSONAL_TOKEN_BYTES).toString('hex')}`;
}

/** 判断字符串形态是否像个人 API token（前缀快速判别，避免无谓 KV 查询） */
export function isPersonalTokenShape(value: string): boolean {
  return value.startsWith(PERSONAL_TOKEN_PREFIX);
}

export class PersonalTokenStore {
  private readonly kv: KvJsonStore<PersonalTokenRecord>;

  constructor(stateDir: string) {
    this.kv = createKvJsonStore<PersonalTokenRecord>(join(stateDir, 'personal-tokens'));
  }

  /** 按凭据本体反查记录；无效/已删除返回 null */
  resolve(token: string): PersonalTokenRecord | null {
    const t = token.trim();
    if (!isPersonalTokenShape(t)) return null;
    return this.kv.get(t);
  }

  /** 记录最近使用时间（best-effort，失败不影响鉴权） */
  touch(token: string): void {
    const rec = this.kv.get(token);
    if (!rec) return;
    this.kv.put(token, { ...rec, lastUsedAt: new Date().toISOString() });
  }

  /**
   * 获取某账号的现有 token；没有则签发一枚（幂等：同一账号长期复用一枚，
   * 与「长期有效 + 可手动吊销/轮换」的策略一致，与渠道用户凭据行为相同）。
   */
  ensure(username: string): PersonalTokenRecord {
    const existing = this.find(username);
    if (existing) return existing;
    return this.issue(username);
  }

  /** 强制为某账号签发一枚新 token（轮换时先 revokeForUser 再调用） */
  issue(username: string): PersonalTokenRecord {
    const name = username.trim();
    if (!name) throw new Error('username 必填');
    const record: PersonalTokenRecord = {
      token: newPersonalToken(),
      username: name,
      createdAt: new Date().toISOString(),
    };
    this.kv.put(record.token, record);
    return record;
  }

  /** 查到某账号的唯一（最新）token 记录；无则 null */
  find(username: string): PersonalTokenRecord | null {
    const all = this.kv.list().filter((r) => r.username === username);
    if (all.length === 0) return null;
    // 理论上一个账号只有一枚（ensure 幂等）；多枚时取最近创建
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return all[0] ?? null;
  }

  /** 吊销指定凭据（仅当属于该账号时生效，自助接口防越权删除他人 token） */
  revoke(username: string, token: string): boolean {
    const t = token.trim();
    const rec = this.kv.get(t);
    if (!rec || rec.username !== username) return false;
    this.kv.delete(t);
    return true;
  }

  /** 删除某账号的全部 token（轮换 / 删除登录账号时级联清理） */
  revokeForUser(username: string): void {
    for (const r of this.kv.list()) {
      if (r.username === username) this.kv.delete(r.token);
    }
  }
}
