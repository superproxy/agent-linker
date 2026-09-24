import { normalizeAgentId } from './adapter.js';
import type { NodeAgentListItem } from './config.js';
import type { NodeAgentInfo } from './node.js';

/** 从 node.agents 配置项解析 agent id */
export function nodeAgentEntryId(item: NodeAgentListItem): string {
  return normalizeAgentId(typeof item === 'string' ? item : item.id);
}

/**
 * 按 node.agents 配置 + 实际上线 id 列表，生成 hello 自报清单（含 permissionMode / permissionPolicy）。
 * 权限只读 node 段，不读 gateway.agents。
 */
export function resolveNodeAgentInfos(nodeAgents: NodeAgentListItem[], agentIds: string[]): NodeAgentInfo[] {
  const byId = new Map<string, NodeAgentInfo>();
  for (const item of nodeAgents) {
    if (typeof item === 'string') {
      const id = normalizeAgentId(item);
      if (!byId.has(id)) byId.set(id, { id });
      continue;
    }
    const id = normalizeAgentId(item.id);
    byId.set(id, {
      id,
      ...(item.displayName?.trim() ? { displayName: item.displayName.trim() } : {}),
      ...(item.permissionMode ? { permissionMode: item.permissionMode } : {}),
      ...(item.permissionPolicy ? { permissionPolicy: item.permissionPolicy } : {}),
    });
  }
  return agentIds.map((raw) => {
    const id = normalizeAgentId(raw);
    return byId.get(id) ?? { id };
  });
}
