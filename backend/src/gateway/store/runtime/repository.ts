import type { AgentDefinition, SharedConfig } from '@linkagent/shared';
import type { GatewayRuntimeOverlay } from './overlay.js';

/**
 * 网关「运行时配置」仓储（启动前 config.yaml + 运行时可变项）。
 * 当前默认实现为 `.runtime-state/gateway/overlay.json`；后续可换 SQLite 等同逻辑后端。
 */
export interface GatewayRuntimeRepository {
  loadOverlay(): GatewayRuntimeOverlay | null;
  saveOverlay(overlay: GatewayRuntimeOverlay): void;

  /** 无持久化快照时，从 yaml 一次性迁入运行时字段（不删 yaml，仅以后以仓储为准） */
  ensureBootstrapped(yamlConfig: SharedConfig): GatewayRuntimeOverlay;

  setAgentEnabled(agentId: string, enabled: boolean, defs: AgentDefinition[], yamlAgentIds: string[]): void;
  registerNodeAgent(agentId: string): void;
  setDefaultTaskAgentId(agentId: string): void;
  ensureWeixinAccount(accountId: string): void;
  removeWeixinAccount(accountId: string): void;
  setChildGateway(section: 'weixin' | 'node', url: string, token: string): void;
}

/** @deprecated 旧名，等同 {@link GatewayRuntimeRepository} */
export type RuntimeConfigStore = GatewayRuntimeRepository;
