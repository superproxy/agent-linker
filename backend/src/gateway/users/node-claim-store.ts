import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/**
 * 节点匿名申请时的归属申明码（nu_）：
 *   仅用于 hello.claimToken 标明属主，不参与 WebSocket Upgrade 鉴权。
 *   落盘 .runtime-state/users/node-claims/<token>.json
 */

export const NODE_CLAIM_PREFIX = 'nu_';
const NODE_CLAIM_BYTES = 32;

export interface NodeClaimRecord {
  token: string;
  username: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function newNodeClaimToken(): string {
  return `${NODE_CLAIM_PREFIX}${randomBytes(NODE_CLAIM_BYTES).toString('hex')}`;
}

export function isNodeClaimShape(value: string): boolean {
  return value.startsWith(NODE_CLAIM_PREFIX);
}

export class NodeClaimStore {
  private readonly kv: KvJsonStore<NodeClaimRecord>;

  constructor(stateDir: string) {
    this.kv = createKvJsonStore<NodeClaimRecord>(join(stateDir, 'node-claims'));
  }

  resolve(token: string): NodeClaimRecord | null {
    const t = token.trim();
    if (!isNodeClaimShape(t)) return null;
    return this.kv.get(t);
  }

  touch(token: string): void {
    const rec = this.kv.get(token);
    if (!rec) return;
    this.kv.put(token, { ...rec, lastUsedAt: new Date().toISOString() });
  }

  find(username: string): NodeClaimRecord | null {
    const name = username.trim();
    return this.kv.list().find((r) => r.username === name) ?? null;
  }

  ensure(username: string): NodeClaimRecord {
    const existing = this.find(username);
    if (existing) return existing;
    return this.issue(username);
  }

  issue(username: string): NodeClaimRecord {
    const name = username.trim();
    if (!name) throw new Error('username 必填');
    const record: NodeClaimRecord = {
      token: newNodeClaimToken(),
      username: name,
      createdAt: new Date().toISOString(),
    };
    this.kv.put(record.token, record);
    return record;
  }

  rotate(username: string): NodeClaimRecord | null {
    this.revokeForUser(username);
    return this.issue(username);
  }

  revokeForUser(username: string): void {
    for (const r of this.kv.list()) {
      if (r.username === username) this.kv.delete(r.token);
    }
  }
}
