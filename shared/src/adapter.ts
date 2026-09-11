/**
 * AgentAdapter —— 网关对「一个 agent 后端」的统一抽象。
 * 一期有 opencode 与 pi（均经 acpx 连各自 ACP server，pi 走 pi-acp 桥接）。
 * 领域共享类型集中于此，config 单向依赖本文件。
 */
import type { ChatMessage } from './openai.js';

/** ACP/acpx 的权限模式：写类工具（文件写/终端）在无审批 UI 时一律自动拒绝 */
export const ACP_PERMISSION_MODES = ['approve-all', 'approve-reads', 'deny-all'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODES)[number];

/** 非交互 elicitation（权限请求到达但无人处理）策略 */
export type NonInteractivePermissionPolicy = 'deny' | 'fail';

/** 模型对外 id 统一形如 agent:<agentId>，如 agent:opencode */
export const modelIdFor = (agentId: string): string => `agent:${agentId}`;

export interface AgentDescriptor {
  id: string;
  displayName: string;
  description: string;
}

export interface AgentDefinition {
  id: string;
  /** agent 后端类型：opencode 原生 ACP server；pi 经 pi-acp ACP 桥接 */
  type: 'opencode' | 'pi';
  displayName?: string;
  description?: string;
  /** agent 进程工作目录 */
  cwd?: string;
  /** 透传 ACP 权限模式；一期默认 approve-reads + 非交互 deny => 只读问答 */
  permissionMode?: AcpPermissionMode;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** ACP server 启动命令；缺省按 type 的内置默认（opencode acp / npx -y pi-acp） */
  command?: string[];
  /**
   * 会话默认模型：建会话后经 ACP session/set_config_option（configId "model"）下发。
   * pi（pi-acp）必需——pi 自身默认 provider 可能无可用凭据，需显式指到本机
   * ~/.pi/agent/models.json 已注册的模型（如 "volcengine/deepseek-v4-flash-ga-260731"）；
   * 未设置则不调用，沿用 agent 自身默认。
   */
  model?: string;
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
