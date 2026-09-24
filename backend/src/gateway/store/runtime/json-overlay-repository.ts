import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition, SharedConfig } from '@linkagent/shared';
import type { GatewayRuntimeOverlay } from './overlay.js';
import type { GatewayRuntimeRepository } from './repository.js';
import {
  applyEnsureWeixinAccount,
  applyRegisterNodeAgent,
  applyRemoveWeixinAccount,
  applySetAgentEnabled,
  applySetChildGateway,
  applySetDefaultTaskAgentId,
  mutateOverlay,
  overlayFromYaml,
} from './mutations.js';

/** 当前默认持久化文件名（SQLite 落地后仍可保留作导出/迁移格式） */
export const RUNTIME_OVERLAY_FILENAME = 'overlay.json';

/**
 * 单文件 JSON 快照实现：原子 tmp+rename，与 gateway/store/kv.ts 写模式一致。
 */
export class JsonOverlayGatewayRuntimeRepository implements GatewayRuntimeRepository {
  private readonly file: string;

  constructor(gatewayStateDir: string) {
    mkdirSync(gatewayStateDir, { recursive: true });
    this.file = join(gatewayStateDir, RUNTIME_OVERLAY_FILENAME);
  }

  loadOverlay(): GatewayRuntimeOverlay | null {
    if (!existsSync(this.file)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as GatewayRuntimeOverlay;
      if (raw?.version !== 1) return null;
      return raw;
    } catch {
      return null;
    }
  }

  saveOverlay(overlay: GatewayRuntimeOverlay): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(overlay, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  ensureBootstrapped(yamlConfig: SharedConfig): GatewayRuntimeOverlay {
    const existing = this.loadOverlay();
    if (existing) return existing;
    const { overlay, dirty } = overlayFromYaml(yamlConfig);
    if (dirty) this.saveOverlay(overlay);
    return overlay;
  }

  private persistMutation(fn: (o: GatewayRuntimeOverlay) => void): void {
    const next = mutateOverlay(this.loadOverlay(), fn);
    this.saveOverlay(next);
  }

  setAgentEnabled(agentId: string, enabled: boolean, defs: AgentDefinition[], yamlAgentIds: string[]): void {
    this.persistMutation((o) => applySetAgentEnabled(o, agentId, enabled, defs, yamlAgentIds));
  }

  registerNodeAgent(agentId: string): void {
    this.persistMutation((o) => applyRegisterNodeAgent(o, agentId));
  }

  setDefaultTaskAgentId(agentId: string): void {
    this.persistMutation((o) => applySetDefaultTaskAgentId(o, agentId));
  }

  ensureWeixinAccount(accountId: string): void {
    this.persistMutation((o) => applyEnsureWeixinAccount(o, accountId));
  }

  removeWeixinAccount(accountId: string): void {
    this.persistMutation((o) => applyRemoveWeixinAccount(o, accountId));
  }

  setChildGateway(section: 'weixin' | 'node', url: string, token: string): void {
    this.persistMutation((o) => applySetChildGateway(o, section, url, token));
  }
}
