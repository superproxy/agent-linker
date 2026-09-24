import { normalizeAgentId } from './adapter.js';
import type { SharedConfig } from './config.js';
import type { NodeAgentInfo } from './node.js';

/**
 * 节点连接器自报清单：id 来自 node.agents / 环境变量，权限与展示名来自同机 config 的 gateway.agents。
 * 远程执行机须在本机 config.yaml 的 gateway.agents 里为对应 id 写好 permissionMode / permissionPolicy。
 */
export function buildNodeAgentInfos(config: SharedConfig, agentIds: string[]): NodeAgentInfo[] {
  const defs = new Map(config.gateway.agents.map((d) => [normalizeAgentId(d.id), d] as const));
  return agentIds.map((rawId) => {
    const id = normalizeAgentId(rawId);
    const def = defs.get(id);
    const info: NodeAgentInfo = { id };
    if (def?.displayName?.trim()) info.displayName = def.displayName.trim();
    if (def?.permissionMode) info.permissionMode = def.permissionMode;
    if (def?.permissionPolicy) info.permissionPolicy = def.permissionPolicy;
    return info;
  });
}
