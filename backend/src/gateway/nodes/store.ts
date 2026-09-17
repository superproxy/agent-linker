import type { NodeAdmissionStatus, NodeAgentInfo } from '@linkagent/shared';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/**
 * 节点注册记录（落盘）：在线状态不持久化，仅保留最近一次注册信息与 lastSeenAt。
 * status/secret 为准入机制：
 *   - status 缺省（存量记录）按 approved 处理
 *   - secret 为网关为该节点签发的重连凭证（敏感，不随 REST 列表返回）
 */
export interface NodeRecord {
  nodeId: string;
  name: string;
  agents: NodeAgentInfo[];
  version?: string;
  status?: NodeAdmissionStatus;
  secret?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface NodeRegistry {
  get(nodeId: string): NodeRecord | null;
  upsert(record: NodeRecord): void;
  remove(nodeId: string): void;
  list(): NodeRecord[];
}

export function createNodeRegistry(stateDir: string): NodeRegistry {
  const kv: KvJsonStore<NodeRecord> = createKvJsonStore<NodeRecord>(stateDir);
  return {
    get: (nodeId) => kv.get(nodeId),
    upsert: (record) => kv.put(record.nodeId, record),
    remove: (nodeId) => kv.delete(nodeId),
    list: () => kv.list().sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  };
}
