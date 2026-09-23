/**
 * AgentAdapter —— 网关对「一个 agent 后端」的统一抽象。
 * 支持全部 ACP agent（经 acpx 连各自 ACP server）：
 * 预置 opencode / pi / workbuddy / trace-cli / cursor，以及 acpx 内置 registry 的
 * 其余类型。
 * 领域共享类型集中于此，config 单向依赖本文件。
 */
import type { ChatMessage } from './openai.js';

/** ACP/acpx 的权限模式：写类工具（文件写/终端）在无审批 UI 时一律自动拒绝 */
export const ACP_PERMISSION_MODES = ['approve-all', 'approve-reads', 'deny-all'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODES)[number];

/** 策略动作：与 acpx 的 PermissionPolicyAction 一一对应 */
export const ACP_PERMISSION_POLICY_ACTIONS = ['approve', 'deny', 'escalate'] as const;
export type PermissionPolicyAction = (typeof ACP_PERMISSION_POLICY_ACTIONS)[number];

/**
 * ACP 工具权限策略（按工具名模式匹配，优先于 permissionMode；对应 acpx `createAcpRuntime` 的
 * `permissionPolicy`，见 node_modules acpx runtime.d.ts）：
 * - autoApprove：命中即自动放行（如 ["bash", "edit:write"]）；
 * - autoDeny：命中即自动拒绝（写类高危工具按 agent 收紧时用，优先级高于 autoApprove）；
 * - escalate：命中即升级为需要审批（本网关无审批 UI 时等同拒绝，留给带 UI 的宿主）；
 * - defaultAction：未命中任何规则时的兜底动作（缺省不设 = 跟随 permissionMode）。
 * 各字段均为字符串列表，支持 ACP 工具名的精确匹配与子串/前缀匹配。
 */
export interface PermissionPolicySpec {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: PermissionPolicyAction;
}

/**
 * 支持的 ACP agent 类型（单一事实来源：config 校验、启动命令、管理目录均引用此列表）。
 * 默认启用列表见 defaultAgentDefinitions（opencode 原生 ACP；pi 经 pi-acp 桥接；workbuddy 经 `codebuddy --acp`；
 * trace-cli 经 `traecli acp serve`；cursor 经 `agent acp`）。其余为 acpx@0.15.1 内置 registry
 * 的类型（对应 CLI 本机安装后才可用，缺 CLI 时仅标记 unhealthy）；hermes / zcode 不在 acpx 内置
 * registry，经 acpx registry override 注册（hermes：`hermes acp`；zcode：`zcode-acp-server`）。
 * 默认 ACP server 启动命令见 backend acpEngine DEFAULT_COMMANDS。
 */
export const ACP_AGENT_KINDS = [
  'opencode',
  'pi',
  'workbuddy',
  'trace-cli',
  'codex',
  'claude',
  'gemini',
  'cursor',
  'copilot',
  'droid',
  'fast-agent',
  'grok-build',
  'hermes',
  'iflow',
  'kilocode',
  'kimi',
  'kiro',
  'mcode',
  'mux',
  'openclaw',
  'pool',
  'qoder',
  'qwen',
  'zeroclaw',
  'zcode',
] as const;
export type AcpAgentKind = (typeof ACP_AGENT_KINDS)[number];

/** 非交互 elicitation（权限请求到达但无人处理）策略 */
export type NonInteractivePermissionPolicy = 'deny' | 'fail';

/** 模型对外 id 统一形如 agent:<agentId>，如 agent:opencode */
export const modelIdFor = (agentId: string): string => `agent:${agentId}`;

/** 路由/agent 配置 id 归一化：去 agent: 前缀、小写（hermes 非 Hermes） */
export function normalizeAgentId(agentId: string): string {
  let id = agentId.trim();
  if (id.toLowerCase().startsWith('agent:')) id = id.slice('agent:'.length).trim();
  return id.toLowerCase();
}

export interface AgentDescriptor {
  id: string;
  displayName: string;
  description: string;
}

/** 管理后台「支持 ACP 的 Agent 目录」条目（kind → 展示信息 + 默认命令 + 配置状态） */
export interface AgentCatalogItem {
  kind: AcpAgentKind;
  displayName: string;
  description: string;
  /** 默认 ACP server 启动命令（展示 + 一键添加时生成 definition.command） */
  command: string[];
  /** 本机安装命令（管理后台命令框） */
  installCommand?: string;
  /** 是否允许网关按白名单 argv 代执行安装（不含管道/交互脚本） */
  installRunnable?: boolean;
  /** 安装说明 */
  installHint?: string;
  /** 是否已配置（config.yaml / 默认定义含该 kind） */
  configured: boolean;
  /** 当前是否启用（configured 且未停用） */
  enabled: boolean;
}

export interface AgentDefinition {
  id: string;
  /** agent 后端类型：见 ACP_AGENT_KINDS；默认启用列表见 defaultAgentDefinitions */
  type: AcpAgentKind;
  displayName?: string;
  description?: string;
  /** agent 进程工作目录 */
  cwd?: string;
  /** 透传 ACP 权限模式；一期默认 approve-reads + 非交互 deny => 只读问答 */
  permissionMode?: AcpPermissionMode;
  /**
   * ACP 工具权限策略（按工具名匹配，优先于 permissionMode）。配置后对所有走该 agent 的渠道生效
   * （/v1、微信/企微 bot、openclaw 插件任务，均汇聚到本机 AcpWrapper 定义层）。
   * 例如放开只读工具的读权限、拦截高危写命令：
   *   permissionPolicy: { autoApprove: ["bash:read", "edit:read"], autoDeny: ["bash:write"] }
   */
  permissionPolicy?: PermissionPolicySpec;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** ACP server 启动命令；缺省按 type 的内置默认（见 backend acpEngine DEFAULT_COMMANDS） */
  command?: string[];
  /**
   * 会话默认模型：建会话后经 ACP session/set_config_option（configId "model"）下发。
   * 取值必须是该 agent 已注册的模型（pi 为 ~/.pi/agent/models.json 的 providerId/modelId）。
   * 未设置则不调用，沿用 agent 自身默认（pi 读 ~/.pi/agent/settings.json）。
   */
  model?: string;
  /** 是否启用；缺省 true。写入 config.yaml 后重启保留 */
  enabled?: boolean;
}

export interface StreamCallbacks {
  /** 助手正文增量 */
  onText(delta: string): void;
  /** 思考过程增量（可选） */
  onReasoning?(delta: string): void;
  /** 有工具/文件操作动作发生（用于 UI 提示） */
  onToolActivity?(name: string): void;
  /** 本次会话 id（供上层续聊） */
  onSessionId?(sessionId: string): void;
  /** ACP 权限请求（无 UI 审批时通常不会到达） */
  onPermissionRequest?(request: { id: string; message: string; tool: string }): void;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 会话 key：相同 key 复用同一 agent 会话；缺省则每次新会话 */
  sessionKey?: string;
  /** 会话工作目录：任务级 cwd 时传入；缺省用 agent 默认 cwd（definition.cwd / defaultCwd / 网关启动目录） */
  cwd?: string;
  /**
   * 启动 ACP 子进程时叠加的环境变量（默认任务任务管理 skill 的 LINKAGENT_*）。
   * 不写入 agents[].env，按会话隔离；acpx 的 agentProcessEnv 不落盘。
   */
  env?: Record<string, string>;
  permissionMode?: AcpPermissionMode;
}

export interface ChatResult {
  sessionId?: string;
}

export interface AgentAdapter {
  readonly id: string;
  descriptor(): AgentDescriptor;
  /** 把一段 OpenAI 多轮消息派发到 agent，并通过回调逐段吐回 */
  chat(req: ChatRequest, cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult>;
  /** 释放进程等资源 */
  dispose(): Promise<void>;
}
