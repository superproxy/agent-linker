import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/**
 * 用户颁发的机器（节点）token：
 *   一个登录账号可持有多枚，每台远程机器一枚。仅用于节点 WebSocket 握手，
 *   不授予 HTTP 管理权限。落盘 .runtime-state/users/node-tokens/<token>.json。
 */

export const NODE_TOKEN_PREFIX = 'nt_';
const NODE_TOKEN_BYTES = 32;

export interface NodeTokenRecord {
  /** 公开 id（轮换/吊销用），与 token 分离以免 URL 携带明文 */
  id: string;
  /** 凭据本体（nt_<hex>），同时作为 KV 键 */
  token: string;
  username: string;
  label?: string;
  /** 首次成功握手后锁定，防止同一 token 再开第二台机器 */
  nodeId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function newNodeToken(): string {
  return `${NODE_TOKEN_PREFIX}${randomBytes(NODE_TOKEN_BYTES).toString('hex')}`;
}

export function newNodeTokenId(): string {
  return `ntk_${randomBytes(8).toString('hex')}`;
}

export function isNodeTokenShape(value: string): boolean {
  return value.startsWith(NODE_TOKEN_PREFIX);
}

export class NodeTokenStore {
  private readonly kv: KvJsonStore<NodeTokenRecord>;

  constructor(stateDir: string) {
    this.kv = createKvJsonStore<NodeTokenRecord>(join(stateDir, 'node-tokens'));
  }

  resolve(token: string): NodeTokenRecord | null {
    const t = token.trim();
    if (!isNodeTokenShape(t)) return null;
    return this.kv.get(t);
  }

  getById(username: string, id: string): NodeTokenRecord | null {
    const rec = this.kv.list().find((r) => r.id === id && r.username === username);
    return rec ?? null;
  }

  touch(token: string): void {
    const rec = this.kv.get(token);
    if (!rec) return;
    this.kv.put(token, { ...rec, lastUsedAt: new Date().toISOString() });
  }

  /**
   * 首次握手锁定 nodeId。已锁定且一致 → 成功；已锁定到其它节点 → 失败。
   */
  bindNode(token: string, nodeId: string): boolean {
    const rec = this.kv.get(token);
    if (!rec) return false;
    if (rec.nodeId && rec.nodeId !== nodeId) return false;
    this.kv.put(token, {
      ...rec,
      nodeId,
      lastUsedAt: new Date().toISOString(),
    });
    return true;
  }

  issue(username: string, label?: string): NodeTokenRecord {
    const name = username.trim();
    if (!name) throw new Error('username 必填');
    const trimmed = label?.trim();
    const record: NodeTokenRecord = {
      id: newNodeTokenId(),
      token: newNodeToken(),
      username: name,
      ...(trimmed ? { label: trimmed } : {}),
      createdAt: new Date().toISOString(),
    };
    this.kv.put(record.token, record);
    return record;
  }

  listForUser(username: string): NodeTokenRecord[] {
    return this.kv
      .list()
      .filter((r) => r.username === username)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  rotate(username: string, id: string): NodeTokenRecord | null {
    const old = this.getById(username, id);
    if (!old) return null;
    this.kv.delete(old.token);
    const next: NodeTokenRecord = {
      id: old.id,
      token: newNodeToken(),
      username: old.username,
      ...(old.label ? { label: old.label } : {}),
      createdAt: new Date().toISOString(),
    };
    this.kv.put(next.token, next);
    return next;
  }

  revoke(username: string, id: string): boolean {
    const rec = this.getById(username, id);
    if (!rec) return false;
    this.kv.delete(rec.token);
    return true;
  }

  revokeForUser(username: string): void {
    for (const r of this.kv.list()) {
      if (r.username === username) this.kv.delete(r.token);
    }
  }
}
