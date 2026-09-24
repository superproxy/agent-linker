import type { AgentDefinition, SharedConfig } from '@linkagent/shared';
import { nodeAgentEntryId, normalizeAgentId } from '@linkagent/shared';

/** 运行时层相对 config.yaml 的覆盖快照（JSON 文件或 SQLite 行集的等价物） */
export interface GatewayRuntimeOverlay {
  version: 1;
  agents?: {
    extra?: AgentDefinition[];
    enabled?: Record<string, boolean>;
  };
  node?: {
    extraAgentIds?: string[];
  };
  tasks?: { defaultAgentId?: string };
  weixin?: {
    accounts?: string[];
    mode?: 'weixin-bot' | 'openclaw-weixin-plugin' | 'external';
    enabled?: boolean;
  };
  childGateway?: {
    weixin?: { gatewayUrl?: string; gatewayToken?: string };
    node?: { gatewayUrl?: string; gatewayToken?: string };
  };
}

export function emptyRuntimeOverlay(): GatewayRuntimeOverlay {
  return { version: 1 };
}

/** 启动前 yaml + 运行时快照 → 三进程共享有效配置（与持久化后端无关） */
export function applyRuntimeOverlay(base: SharedConfig, overlay: GatewayRuntimeOverlay | null): SharedConfig {
  if (!overlay) return base;

  const byId = new Map<string, AgentDefinition>();
  for (const a of base.gateway.agents) byId.set(a.id, { ...a });
  for (const extra of overlay.agents?.extra ?? []) {
    byId.set(extra.id, { ...extra });
  }
  const gatewayAgents = [...byId.values()].map((a) => {
    const en = overlay.agents?.enabled?.[a.id];
    if (en === undefined) return a;
    return { ...a, enabled: en };
  });

  const gateway = {
    ...base.gateway,
    agents: gatewayAgents,
    tasks: overlay.tasks?.defaultAgentId
      ? { ...base.gateway.tasks, defaultAgentId: overlay.tasks.defaultAgentId }
      : base.gateway.tasks,
  };

  let weixin = { ...base.weixin };
  if (overlay.weixin?.accounts !== undefined) weixin = { ...weixin, accounts: [...overlay.weixin.accounts] };
  if (overlay.weixin?.mode !== undefined) weixin = { ...weixin, mode: overlay.weixin.mode };
  if (overlay.weixin?.enabled !== undefined) weixin = { ...weixin, enabled: overlay.weixin.enabled };

  let node = { ...base.node };
  const extraIds = overlay.node?.extraAgentIds ?? [];
  if (extraIds.length > 0) {
    const seen = new Set(node.agents.map(nodeAgentEntryId));
    const merged = [...node.agents];
    for (const raw of extraIds) {
      const id = normalizeAgentId(raw);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    node = { ...node, agents: merged };
  }

  if (overlay.childGateway?.weixin) {
    const w = overlay.childGateway.weixin;
    if (w.gatewayUrl !== undefined) weixin = { ...weixin, gatewayUrl: w.gatewayUrl };
    if (w.gatewayToken !== undefined) weixin = { ...weixin, gatewayToken: w.gatewayToken };
  }
  if (overlay.childGateway?.node) {
    const n = overlay.childGateway.node;
    if (n.gatewayUrl !== undefined) node = { ...node, gatewayUrl: n.gatewayUrl };
    if (n.gatewayToken !== undefined) node = { ...node, gatewayToken: n.gatewayToken };
  }

  return { gateway, weixin, channelGateway: base.channelGateway, node };
}
