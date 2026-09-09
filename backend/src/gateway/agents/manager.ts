import { join } from 'node:path';
import type { AgentAdapter, AgentDefinition, AgentDescriptor } from '@linkagent/shared';
import { modelIdFor } from '@linkagent/shared';
import { findRepoRoot } from '../config.js';
import { AcpAdapter, type AcpAgentKind } from './opencode.js';

export interface ManagerOptions {
  /** agent 定义 */
  definitions: AgentDefinition[];
  /** 会话状态根目录，缺省 <repoRoot>/.runtime-state/acpx */
  stateDir?: string;
  repoRoot?: string;
}

/** 控制台/控制 API 看到的 agent 运行态（含可在运行时切换的 model 与 enabled） */
export interface AgentDetail {
  id: string;
  type: AcpAgentKind;
  displayName: string;
  description: string;
  /** 当前生效的会话模型（undefined=agent 自身默认） */
  model?: string;
  /** 运行时是否启用：停用后不出现在 /v1/models，chat 解析返回 model_not_found */
  enabled: boolean;
}

export interface AgentPatch {
  /** 热切换会话模型；null/undefined 语义由 setModel 决定（null→回 config 默认） */
  model?: string | null;
  /** 启停 */
  enabled?: boolean;
}

/** 统一管理所有 agent 后端实例；对外按模型 id 解析 */
export class AgentManager {
  private readonly adapters = new Map<string, AcpAdapter>();
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly definitions: AgentDefinition[];
  private readonly stateDir: string;
  private readonly enabled = new Set<string>();

  constructor(options: ManagerOptions) {
    this.definitions = options.definitions;
    const repo = options.repoRoot ?? findRepoRoot();
    this.stateDir = options.stateDir ?? join(repo, '.runtime-state', 'acpx');
  }

  async start(): Promise<void> {
    const seen = new Set<string>();
    for (const def of this.definitions) {
      if (seen.has(def.id)) throw new Error(`agent id 重复: ${def.id}`);
      seen.add(def.id);
      // AcpAdapter 内部按 definition.type 决定 ACP agent key 与默认命令
      const adapter = new AcpAdapter({ definition: def, stateDir: this.stateDir });
      this.adapters.set(def.id, adapter);
      this.descriptors.set(modelIdFor(def.id), adapter.descriptor());
      this.enabled.add(def.id);
    }
  }

  /** 将模型 id 解析为 adapter：形如 agent:opencode；已停用的 agent 返回 undefined */
  resolve(modelId: string): AgentAdapter | undefined {
    const key = modelId.replace(/^agent:/, '');
    const adapter = this.adapters.get(key);
    if (!adapter || !this.enabled.has(key)) return undefined;
    return adapter;
  }

  /** 当前启用 agent 的对外描述（/v1/models、healthz） */
  listDescriptors(): AgentDescriptor[] {
    return [...this.descriptors.entries()]
      .filter(([modelId]) => {
        const id = modelId.replace(/^agent:/, '');
        return this.enabled.has(id);
      })
      .map(([, d]) => d);
  }

  has(modelId: string): boolean {
    const key = modelId.replace(/^agent:/, '');
    return this.enabled.has(key) && this.adapters.has(key);
  }

  /** 全部 agent 运行态详情（含停用的，供控制台启用回来） */
  listAgentDetails(): AgentDetail[] {
    return this.definitions.map((def) => {
      const adapter = this.adapters.get(def.id);
      const label = adapter?.descriptor();
      return {
        id: def.id,
        type: adapter?.type ?? def.type,
        displayName: label?.displayName ?? def.id,
        description: label?.description ?? '',
        model: adapter?.model,
        enabled: this.enabled.has(def.id),
      };
    });
  }

  /**
   * 运行时热更新某个 agent（模型 / 启停）。仅内存生效，重启还原 config/gateway.yaml。
   * 未知 agent 抛错；返回更新后的详情。
   */
  updateAgent(id: string, patch: AgentPatch): AgentDetail {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`未知 agent: ${id}`);
    if (patch.model !== undefined) adapter.setModel(patch.model);
    if (patch.enabled !== undefined) {
      if (patch.enabled) this.enabled.add(id);
      else this.enabled.delete(id);
    }
    const detail = this.listAgentDetails().find((d) => d.id === id);
    if (!detail) throw new Error(`agent 详情不可用: ${id}`);
    return detail;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.dispose().catch(() => {})));
    this.adapters.clear();
    this.descriptors.clear();
    this.enabled.clear();
  }
}
