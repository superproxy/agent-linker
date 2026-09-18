import { join } from 'node:path';
import type { AgentAdapter, AgentCatalogItem, AgentDefinition, AgentDescriptor } from '@linkagent/shared';
import { ACP_AGENT_KINDS, LOCAL_NODE_ID, modelIdFor } from '@linkagent/shared';
import { getLayout } from '../../install/layout.js';
import type { NodeManager } from '../nodes/manager.js';
import type { NodeLink } from '../nodes/link.js';
import { RemoteNodeAdapter } from './remoteWrapper.js';
import { AcpWrapper, AGENT_CATALOG, type AcpAgentKind } from './acpWrapper.js';

export interface ManagerOptions {
  /** agent 定义（内建 local 节点） */
  definitions: AgentDefinition[];
  /** 会话状态根目录，缺省 <repoRoot>/.runtime-state/acpx */
  stateDir?: string;
  /** agent 默认工作目录：agent 未配 cwd 时用它（透传给 AcpWrapper） */
  defaultCwd?: string;
  repoRoot?: string;
  /** 远程节点管理器（可选；提供后按节点上下线增删 RemoteNodeAdapter） */
  nodeManager?: NodeManager;
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

/** 一个可路由的 agent 落点（节点 + agent） */
export interface RoutingAgent {
  nodeId: string;
  agentId: string;
  online: boolean;
  displayName: string;
}

/** 统一管理所有 agent 后端实例（内建 local + 远程节点）；对外按 (nodeId, agentId) 解析 */
export class AgentManager {
  /** 内建 local 节点的 agent 适配器：agentId → wrapper */
  private readonly adapters = new Map<string, AcpWrapper>();
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private definitions: AgentDefinition[];
  private readonly stateDir: string;
  private readonly defaultCwd: string;
  private readonly enabled = new Set<string>();
  private readonly nodeManager?: NodeManager;
  /** 远程适配器：nodeId → (agentId → adapter) */
  private readonly remote = new Map<string, Map<string, RemoteNodeAdapter>>();
  private unsubscribeNodes?: () => void;

  constructor(options: ManagerOptions) {
    this.definitions = options.definitions;
    // 显式 repoRoot（测试用）时按其下 .runtime-state/acpx 解析；否则走安装布局
    this.stateDir = options.stateDir ?? (options.repoRoot ? join(options.repoRoot, '.runtime-state', 'acpx') : getLayout().acpxState);
    this.defaultCwd = options.defaultCwd ?? '';
    this.nodeManager = options.nodeManager;
  }

  async start(): Promise<void> {
    const seen = new Set<string>();
    for (const def of this.definitions) {
      if (seen.has(def.id)) throw new Error(`agent id 重复: ${def.id}`);
      seen.add(def.id);
      // AcpWrapper 内部按 definition.type 决定 ACP agent key 与默认命令
      const adapter = new AcpWrapper({
        definition: def,
        stateDir: this.stateDir,
        defaultCwd: this.defaultCwd,
      });
      this.adapters.set(def.id, adapter);
      this.descriptors.set(modelIdFor(def.id), adapter.descriptor());
      this.enabled.add(def.id);
    }
    if (this.nodeManager) {
      // 启动时已在线的节点（理论上连接在 WS server listen 后才建立，这里做防御性同步）
      for (const node of this.nodeManager.list()) if (node.online) this.attachNode(node.nodeId);
      this.unsubscribeNodes = this.nodeManager.onChange((nodeId, online) => {
        if (online) this.attachNode(nodeId);
        else this.detachNode(nodeId);
      });
    }
  }

  /** 节点上线：为其每个自报 agent 建远程适配器 */
  private attachNode(nodeId: string): void {
    if (!this.nodeManager || nodeId === LOCAL_NODE_ID) return;
    const link: NodeLink | undefined = this.nodeManager.getLink(nodeId);
    if (!link) return;
    const map = new Map<string, RemoteNodeAdapter>();
    for (const agentId of this.nodeManager.onlineAgentIds(nodeId)) {
      const info = this.nodeManager.list().find((n) => n.nodeId === nodeId);
      const meta = info?.agents.find((a) => a.id === agentId);
      map.set(agentId, new RemoteNodeAdapter(nodeId, agentId, link, meta?.displayName));
    }
    this.remote.set(nodeId, map);
  }

  /** 节点离线：移除其全部远程适配器（进行中 turn 由 NodeManager 以 NodeOfflineError 终止） */
  private detachNode(nodeId: string): void {
    this.remote.delete(nodeId);
  }

  /** 将模型 id 解析为内建 local adapter：形如 agent:opencode；已停用的 agent 返回 undefined */
  resolve(modelId: string): AgentAdapter | undefined {
    const key = modelId.replace(/^agent:/, '');
    const adapter = this.adapters.get(key);
    if (!adapter || !this.enabled.has(key)) return undefined;
    return adapter;
  }

  /**
   * 任务路由解析：按 (nodeId, agentId) 取 adapter。
   * - local：agent 未配置/停用 → 'unknown'；
   * - 远程：节点离线 → 'offline'；节点在线但未自报该 agent → 'unknown'；
   * - 成功 → { kind:'ok', adapter }。
   */
  resolveForRouting(nodeId: string | undefined, agentId: string):
    | { kind: 'ok'; adapter: AgentAdapter }
    | { kind: 'offline'; nodeId: string }
    | { kind: 'unknown' } {
    const node = nodeId?.trim() || LOCAL_NODE_ID;
    if (node === LOCAL_NODE_ID) {
      const adapter = this.adapters.get(agentId);
      if (!adapter || !this.enabled.has(agentId)) return { kind: 'unknown' };
      return { kind: 'ok', adapter };
    }
    if (!this.nodeManager || !this.nodeManager.isOnline(node)) return { kind: 'offline', nodeId: node };
    const adapter = this.remote.get(node)?.get(agentId);
    if (!adapter) return { kind: 'unknown' };
    return { kind: 'ok', adapter };
  }

  /** 全部可路由 agent 落点（任务弹窗级联选择用）：local 已启用项 + 在线节点自报项 */
  listRoutingAgents(): RoutingAgent[] {
    const out: RoutingAgent[] = [];
    for (const def of this.definitions) {
      if (!this.enabled.has(def.id)) continue;
      out.push({
        nodeId: LOCAL_NODE_ID,
        agentId: def.id,
        online: true,
        displayName: def.displayName || def.id,
      });
    }
    if (this.nodeManager) {
      for (const node of this.nodeManager.list()) {
        if (!node.online || node.nodeId === LOCAL_NODE_ID) continue;
        for (const a of node.agents) {
          out.push({ nodeId: node.nodeId, agentId: a.id, online: true, displayName: a.displayName || a.id });
        }
      }
    }
    return out;
  }

  /** (nodeId, agentId) 是否当前可路由（任务绑定校验用） */
  hasRoutingAgent(nodeId: string | undefined, agentId: string): boolean {
    return this.resolveForRouting(nodeId, agentId).kind === 'ok';
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
   * 运行时热更新某个 agent（模型 / 启停）。仅内存生效，重启还原 config/config.yaml。
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

  /**
   * 运行时热添加一个 agent（仅内存生效，重启还原 config/config.yaml）。
   * id 重复或类型未知抛错；返回新 agent 的详情。
   */
  addAgent(def: AgentDefinition): AgentDetail {
    if (this.adapters.has(def.id)) throw new Error(`agent id 已存在: ${def.id}`);
    if (!ACP_AGENT_KINDS.includes(def.type)) throw new Error(`未知 agent 类型: ${def.type}`);
    const adapter = new AcpWrapper({
      definition: def,
      stateDir: this.stateDir,
      defaultCwd: this.defaultCwd,
    });
    this.adapters.set(def.id, adapter);
    this.descriptors.set(modelIdFor(def.id), adapter.descriptor());
    this.enabled.add(def.id);
    this.definitions.push(def);
    const detail = this.listAgentDetails().find((d) => d.id === def.id);
    if (!detail) throw new Error(`agent 详情不可用: ${def.id}`);
    return detail;
  }

  /** 全部支持类型目录 + 配置状态（管理后台「支持 ACP 的 Agent 目录」用） */
  listAgentCatalog(): AgentCatalogItem[] {
    return AGENT_CATALOG.map((entry) => {
      const defs = this.definitions.filter((d) => d.type === entry.kind);
      const configured = defs.length > 0;
      const enabled = configured && defs.some((d) => this.enabled.has(d.id));
      return {
        kind: entry.kind,
        displayName: entry.displayName,
        description: entry.description,
        command: entry.command,
        installCommand: entry.installCommand,
        installRunnable: entry.installRunnable,
        ...(entry.installHint ? { installHint: entry.installHint } : {}),
        configured,
        enabled,
      };
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribeNodes?.();
    await Promise.all([...this.adapters.values()].map((a) => a.dispose().catch(() => {})));
    this.adapters.clear();
    this.remote.clear();
    this.descriptors.clear();
    this.enabled.clear();
  }
}
