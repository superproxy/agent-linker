import type { AgentAdapter, AgentDefinition, AgentDescriptor, ChatRequest, ChatResult, StreamCallbacks } from '@linkagent/shared';
import {
  AcpEngine,
  AGENT_CATALOG,
  DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS,
  type AcpAgentKind,
} from './acpEngine.js';

// 向后兼容导出：manager / gateway 入口仍从 acpWrapper.js 引用这些符号
export {
  AcpEngine,
  AGENT_CATALOG,
  DEFAULT_COMMANDS,
  DEFAULT_LABELS,
  DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS,
  installGuideFor,
  expandHome,
  resolveCwd,
  type AcpAgentKind,
  type AgentCatalogEntry,
  type AgentInstallGuide,
  type EngineTurnEvent,
} from './acpEngine.js';

export interface AcpWrapperOptions {
  definition: AgentDefinition;
  /** ACP agent key（registry override 与 probe 名）；缺省取 definition.type */
  agentName?: AcpAgentKind;
  /** acpx 会话状态持久目录（跨进程恢复会话用） */
  stateDir: string;
  /** 启动命令；缺省按 agentName 的内置默认 */
  command?: string[];
  /** agent 默认工作目录：definition.cwd 未配时用它；缺省空串（沿用 process.cwd()） */
  defaultCwd?: string;
  verbose?: boolean;
  /** persistent 会话空闲超时（默认 30 分钟） */
  persistentIdleTimeoutMs?: number;
}

/**
 * ACP 后端适配器（本地）：实现 AgentAdapter，内部委托与传输无关的 AcpEngine。
 * 远程节点连接器同样复用 AcpEngine，保证本地/节点机一套会话生命周期。
 */
export class AcpWrapper implements AgentAdapter {
  readonly id: string;
  private readonly definition: AgentDefinition;
  private readonly engine: AcpEngine;
  /** 运行时模型覆盖（控制台切换）；undefined=沿用 definition.model */
  private modelOverride: string | undefined;

  constructor(options: AcpWrapperOptions) {
    this.definition = options.definition;
    this.id = options.definition.id;
    const agentName = options.agentName ?? options.definition.type;
    this.engine = new AcpEngine({
      id: this.id,
      agentName,
      stateDir: options.stateDir,
      command: options.definition.command ?? options.command,
      defaultCwd: options.definition.cwd?.trim() ? options.definition.cwd : options.defaultCwd,
      displayName: options.definition.displayName,
      description: options.definition.description,
      permissionMode: options.definition.permissionMode,
      env: options.definition.env,
      verbose: options.verbose,
      persistentIdleTimeoutMs: options.persistentIdleTimeoutMs ?? DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS,
    });
  }

  /** agent 后端类型（opencode / pi / workbuddy / trace-cli / cursor 等 ACP_AGENT_KINDS） */
  get type(): AcpAgentKind {
    return this.engine.agentName;
  }

  /** 当前生效的会话模型：运行时切换值优先，未切换则用 definition.model */
  get model(): string | undefined {
    return this.modelOverride ?? this.definition.model;
  }

  /** 热切换会话模型；null/空串/undefined 表示回到 definition.model */
  setModel(model: string | null | undefined): void {
    this.modelOverride = typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
  }

  descriptor(): AgentDescriptor {
    return this.engine.descriptor();
  }

  async chat(req: ChatRequest, cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    return this.engine.chatMessages(req.messages, req.sessionKey?.trim() || undefined, req.cwd, this.model, cb, signal);
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}

/** opencode 便捷子类：默认 ACP agent key 'opencode'（命令 opencode acp） */
export class OpencodeWrapper extends AcpWrapper {
  constructor(options: Omit<AcpWrapperOptions, 'agentName'>) {
    super({ ...options, agentName: 'opencode' });
  }
}

/** pi 便捷子类：默认 ACP agent key 'pi'（命令 npx -y pi-acp） */
export class PiWrapper extends AcpWrapper {
  constructor(options: Omit<AcpWrapperOptions, 'agentName'>) {
    super({ ...options, agentName: 'pi' });
  }
}
