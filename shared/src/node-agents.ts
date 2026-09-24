import { normalizeAgentId } from './adapter.js';
import type { NodeAgentConfigEntry, NodeAgentListItem } from './config.js';
import type { NodeAgentInfo } from './node.js';

/** 从 node.agents 配置项解析 agent id */
export function nodeAgentEntryId(item: NodeAgentListItem): string {
  return normalizeAgentId(typeof item === 'string' ? item : item.id);
}

/** 在 node.agents 中查找对象配置项（字符串项返回 undefined） */
export function findNodeAgentEntry(nodeAgents: NodeAgentListItem[], agentId: string): NodeAgentConfigEntry | undefined {
  const id = normalizeAgentId(agentId);
  for (const item of nodeAgents) {
    if (typeof item === 'string') continue;
    if (normalizeAgentId(item.id) === id) return item;
  }
  return undefined;
}

export interface NodeAcpLaunchOptions {
  command: string[];
  env?: Record<string, string>;
}

/**
 * 节点本机 spawn ACP 时的命令与环境：优先 entry.command，否则 defaultCommand；
 * 配置了 key 且 argv 中尚无 --key 时追加 `--key <key>`（Cursor `agent acp --key`）。
 */
export function resolveNodeAcpLaunch(defaultCommand: string[], entry: NodeAgentConfigEntry | undefined): NodeAcpLaunchOptions {
  const base = entry?.command?.length ? [...entry.command] : [...defaultCommand];
  const key = entry?.key?.trim();
  if (key && !base.includes('--key')) {
    base.push('--key', key);
  }
  const env = entry?.env;
  return env && Object.keys(env).length > 0 ? { command: base, env: { ...env } } : { command: base };
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
