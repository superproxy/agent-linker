import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  USERNAME_PATTERN,
  type SessionRecord,
  type UserRecord,
  type UserRole,
} from '@linkagent/shared';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * 用户与会话存储（.runtime-state/users/）：
 *   accounts/<username>.json   用户记录（含 scrypt 密码哈希）
 *   sessions/<token>.json      登录会话（TTL 过期，滑动续期）
 * 复用通用 KV（tmp+rename 原子写、损坏文件隔离）。
 */

const SESSION_TOKEN_BYTES = 32;

export class UserStore {
  private readonly accounts: KvJsonStore<UserRecord>;
  private readonly sessions: KvJsonStore<SessionRecord>;

  constructor(stateDir: string) {
    this.accounts = createKvJsonStore<UserRecord>(join(stateDir, 'accounts'));
    this.sessions = createKvJsonStore<SessionRecord>(join(stateDir, 'sessions'));
  }

  /** 首次启动初始化默认 admin（store 为空时）；已存在用户则不动 */
  ensureDefaultAdmin(): void {
    if (this.list().length > 0) return;
    this.create({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      role: 'admin',
      displayName: '管理员',
      mustChangePassword: true,
    });
  }

  list(): UserRecord[] {
    return this.accounts.list();
  }

  get(username: string): UserRecord | null {
    return this.accounts.get(username);
  }

  create(input: {
    username: string;
    password: string;
    role?: UserRole;
    displayName?: string;
    mustChangePassword?: boolean;
  }): UserRecord {
    const username = normalizeUsername(input.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error('用户名仅支持字母数字 . _ -，长度 1~32');
    }
    if (this.accounts.get(username)) throw new Error(`用户已存在: ${username}`);
    const record: UserRecord = {
      username,
      passwordHash: hashPassword(input.password),
      role: input.role ?? 'user',
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      createdAt: new Date().toISOString(),
      mustChangePassword: input.mustChangePassword ?? false,
    };
    this.accounts.put(username, record);
    return record;
  }

  /** 更新密码；mustChangePassword 一并落盘 */
  setPassword(username: string, newPassword: string, mustChangePassword: boolean): void {
    const user = this.accounts.get(username);
    if (!user) throw new Error(`用户不存在: ${username}`);
    this.accounts.put(username, {
      ...user,
      passwordHash: hashPassword(newPassword),
      mustChangePassword,
    });
  }

  setDisplayName(username: string, displayName: string | undefined): void {
    const user = this.accounts.get(username);
    if (!user) throw new Error(`用户不存在: ${username}`);
    this.accounts.put(username, { ...user, displayName: displayName?.trim() || undefined });
  }

  delete(username: string): void {
    if (!this.accounts.get(username)) throw new Error(`用户不存在: ${username}`);
    // 连带删除该用户全部会话
    for (const s of this.sessions.list()) {
      if (s.username === username) this.sessions.delete(s.token);
    }
    this.accounts.delete(username);
  }

  /** 校验账号密码，成功返回用户（不区分「用户不存在」与「密码错」，统一报错防枚举） */
  authenticate(username: string, password: string): UserRecord {
    const user = this.accounts.get(normalizeUsername(username));
    if (!user) throw new AuthError('用户名或密码错误');
    if (!verifyPassword(password, user.passwordHash)) throw new AuthError('用户名或密码错误');
    return user;
  }

  // ── 会话 ──

  createSession(username: string, ttlMs: number): SessionRecord {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
    const now = Date.now();
    const record: SessionRecord = {
      token,
      username,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    this.sessions.put(token, record);
    return record;
  }

  /**
   * 取有效会话；过期返回 null 并清理。
   * sliding=true 时滑动续期（每次鉴权把过期时间向后推一个 TTL）。
   */
  resolveSession(token: string, ttlMs: number, sliding = true): SessionRecord | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    if (sliding) {
      const renewed: SessionRecord = { ...session, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
      this.sessions.put(token, renewed);
      return renewed;
    }
    return session;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }
}

/** 登录凭据错误（与「用户不存在」等参数错误区分 HTTP 状态码） */
export class AuthError extends Error {}

function normalizeUsername(username: string): string {
  return String(username ?? '').trim();
}
