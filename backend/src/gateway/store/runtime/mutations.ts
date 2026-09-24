import type { AgentDefinition, WeixinMode } from '@linkagent/shared';
import { normalizeAgentId, normalizeWeixinMode } from '@linkagent/shared';
import type { GatewayRuntimeOverlay } from './overlay.js';
import { emptyRuntimeOverlay } from './overlay.js';

export function overlayFromYaml(yamlConfig: {
  gateway: { agents: AgentDefinition[]; tasks: { defaultAgentId: string } };
  weixin: {
    accounts: string[];
    mode: string;
    enabled: boolean;
    gatewayUrl: string;
    gatewayToken: string;
  };
  node: { gatewayUrl: string; gatewayToken: string };
}): { overlay: GatewayRuntimeOverlay; dirty: boolean } {
  const overlay = emptyRuntimeOverlay();
  let dirty = false;

  const enabled: Record<string, boolean> = {};
  for (const a of yamlConfig.gateway.agents) {
    if (a.enabled === false) enabled[a.id] = false;
  }
  if (Object.keys(enabled).length > 0) {
    overlay.agents = { enabled };
    dirty = true;
  }

  const wxMode = normalizeWeixinMode(yamlConfig.weixin.mode);
  if (yamlConfig.weixin.accounts.length > 0 || wxMode === 'raw') {
    overlay.weixin = {
      accounts: [...yamlConfig.weixin.accounts],
      mode: wxMode,
      enabled: yamlConfig.weixin.enabled,
    };
    dirty = true;
  }

  if (yamlConfig.weixin.gatewayUrl.trim() || yamlConfig.weixin.gatewayToken.trim()) {
    overlay.childGateway = {
      ...(overlay.childGateway ?? {}),
      weixin: {
        gatewayUrl: yamlConfig.weixin.gatewayUrl,
        gatewayToken: yamlConfig.weixin.gatewayToken,
      },
    };
    dirty = true;
  }
  if (yamlConfig.node.gatewayUrl.trim() || yamlConfig.node.gatewayToken.trim()) {
    overlay.childGateway = {
      ...(overlay.childGateway ?? {}),
      node: {
        gatewayUrl: yamlConfig.node.gatewayUrl,
        gatewayToken: yamlConfig.node.gatewayToken,
      },
    };
    dirty = true;
  }

  const defaultPi = 'pi';
  if (yamlConfig.gateway.tasks.defaultAgentId !== defaultPi) {
    overlay.tasks = { defaultAgentId: yamlConfig.gateway.tasks.defaultAgentId };
    dirty = true;
  }

  return { overlay, dirty };
}

export function mutateOverlay(
  current: GatewayRuntimeOverlay | null,
  fn: (o: GatewayRuntimeOverlay) => void,
): GatewayRuntimeOverlay {
  const next = current ?? emptyRuntimeOverlay();
  fn(next);
  return next;
}

export function applySetAgentEnabled(
  o: GatewayRuntimeOverlay,
  agentId: string,
  enabled: boolean,
  defs: AgentDefinition[],
  yamlAgentIds: string[],
): void {
  const id = agentId.trim();
  const agents = o.agents ?? {};
  const yamlSet = new Set(yamlAgentIds);
  if (yamlAgentIds.length === 0 && !(agents.extra?.length ?? 0)) {
    agents.extra = defs.map((d) => ({ ...d }));
  }
  const src = defs.find((d) => d.id === id);
  if (src && !yamlSet.has(id) && !(agents.extra ?? []).some((e) => e.id === id)) {
    agents.extra = [...(agents.extra ?? []), { ...src }];
  }
  agents.enabled = { ...(agents.enabled ?? {}), [id]: enabled };
  o.agents = agents;
}

export function applyRegisterNodeAgent(o: GatewayRuntimeOverlay, agentId: string): void {
  const id = normalizeAgentId(agentId);
  const node = o.node ?? {};
  const list = node.extraAgentIds ?? [];
  if (!list.includes(id)) node.extraAgentIds = [...list, id];
  o.node = node;
}

export function applySetDefaultTaskAgentId(o: GatewayRuntimeOverlay, agentId: string): void {
  o.tasks = { defaultAgentId: agentId.trim() };
}

export function applyEnsureWeixinAccount(o: GatewayRuntimeOverlay, accountId: string): void {
  const id = accountId.trim();
  const w = o.weixin ?? {};
  const accounts = w.accounts ?? [];
  if (!accounts.includes(id)) w.accounts = [...accounts, id];
  w.mode = 'raw';
  w.enabled = true;
  o.weixin = w;
}

export function applySetWeixinMode(o: GatewayRuntimeOverlay, mode: WeixinMode): void {
  const w = o.weixin ?? {};
  w.mode = normalizeWeixinMode(mode);
  o.weixin = w;
}

export function applyRemoveWeixinAccount(o: GatewayRuntimeOverlay, accountId: string): void {
  const id = accountId.trim();
  if (!o.weixin?.accounts) return;
  o.weixin = { ...o.weixin, accounts: o.weixin.accounts.filter((x) => x !== id) };
}

export function applySetChildGateway(
  o: GatewayRuntimeOverlay,
  section: 'weixin' | 'node',
  url: string,
  token: string,
): void {
  const normalizedUrl = url.trim().replace(/\/+$/, '');
  const normalizedToken = token.trim();
  const cg = o.childGateway ?? {};
  const patch = { gatewayUrl: normalizedUrl, gatewayToken: normalizedToken };
  if (section === 'weixin') cg.weixin = patch;
  else cg.node = patch;
  o.childGateway = cg;
}
