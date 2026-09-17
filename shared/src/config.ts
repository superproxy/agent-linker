import { z } from 'zod';
import { ACP_AGENT_KINDS, ACP_PERMISSION_MODES } from './adapter.js';
import type { AgentDefinition } from './adapter.js';

export type { AcpPermissionMode, NonInteractivePermissionPolicy, AgentDefinition } from './adapter.js';

export const agentDefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ACP_AGENT_KINDS),
  displayName: z.string().optional(),
  description: z.string().optional(),
  cwd: z.string().optional(),
  // 缺省值在 AcpWrapper 侧兜底为 approve-reads（与 AgentDefinition.permissionMode 的 optional 一致）
  permissionMode: z.enum(ACP_PERMISSION_MODES).optional(),
  env: z.record(z.string(), z.string()).optional(),
  command: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export const gatewayConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(8787),
    })
    .default({ host: '127.0.0.1', port: 8787 }),
  auth: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().default(''),
      /** 登录会话有效期（天），到期需重新登录；默认 7 天 */
      sessionTtlDays: z.number().positive().default(7),
    })
    .default({ enabled: false, token: '', sessionTtlDays: 7 }),
  agents: z.array(agentDefSchema).default([]),
  /** agent 默认工作目录：agent 未显式配 cwd 时用它作为 ACP 进程/会话的工作目录；缺省为空串（沿用网关启动目录） */
  defaultCwd: z.string().default(''),
  /** 预留：渠道配置（微信等）二期接入 */
  channels: z.record(z.string(), z.unknown()).default({}),
  /** openclaw 渠道插件包（企业微信默认内置；个人微信 @tencent-weixin/openclaw-weixin） */
  plugins: z
    .array(z.object({ package: z.string().min(1), enabled: z.boolean().default(true) }))
    .default([]),
  /** 个人微信渠道实现方式（gateway 启动时二选一） */
  weixin: z
    .object({
      /**
       * openclaw-weixin-plugin：openclaw 插件运行时（加载 plugins 里的 @tencent-weixin/openclaw-weixin，登录态复用同目录）
       * weixin-bot：独立标准 adapter（gateway 进程内拉起，走 ilink 长轮询 + 网关 SSE，默认）
       * external：独立标准 adapter，但由外部进程管理器单独拉起（gateway 不再内嵌，避免同账号重复收消息）
       */
      mode: z.enum(['weixin-bot', 'openclaw-weixin-plugin', 'external']).default('weixin-bot'),
      /** weixin-bot 模式：登录态账号 id（缺省取 accounts/ 下第一个） */
      accountId: z.string().optional(),
      /** weixin-bot 模式：对话模型（默认 agent:opencode） */
      model: z.string().optional(),
    })
    .default({ mode: 'weixin-bot' }),
  /** 任务公共能力（多渠道共享）：默认任务绑定的 agent（缺省 opencode） */
  tasks: z
    .object({
      defaultAgentId: z.string().default('opencode'),
      /** 任务工作空间根目录：配置后每个任务默认独立目录 <root>/<userId>/<taskId>（任务间隔离） */
      workspaceDir: z.string().optional(),
    })
    .default({ defaultAgentId: 'opencode' }),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/**
 * 缺省 agent（无配置文件时可开箱即用）；pi 依赖本机已装 pi 与 pi-acp，
 * workbuddy 依赖本机已装 codebuddy（CodeBuddy Code CLI），trace-cli 依赖本机已装 traecli（TraeCode CLI）。
 * 对应 CLI 未安装时 gateway 仍正常启动（probe 仅标记 unhealthy），实际调用会报 ACP_BACKEND_UNAVAILABLE。
 * pi 默认会话模型绑定本机 ~/.pi/agent/models.json 已注册的 volcengine ark（deepseek-v4-flash）：
 * 其它机器若无同名模型，可自建 config 的 agents 配置改 model，或删掉 model 字段让 pi 用其自身默认。
 * 其余 ACP 类型（codex/claude/gemini/…，见 ACP_AGENT_KINDS）不在默认列表：
 * 可在管理后台「支持 ACP 的 Agent 目录」一键添加，或自建 config 的 agents 配置。
 */
export function defaultAgentDefinitions(): AgentDefinition[] {
  return [
    {
      id: 'opencode',
      type: 'opencode',
      displayName: 'OpenCode',
      description: '本地 opencode（经 ACP/acpx），默认只读问答',
    },
    {
      id: 'pi',
      type: 'pi',
      displayName: 'Pi',
      description: '本地 pi（pi-coding-agent，经 pi-acp ACP 桥接），默认只读问答',
      model: 'volcengine/deepseek-v4-flash-ga-260731',
    },
    {
      id: 'workbuddy',
      type: 'workbuddy',
      displayName: 'WorkBuddy',
      description: 'CodeBuddy Code CLI（经 codebuddy --acp），默认只读问答',
    },
    {
      id: 'trace-cli',
      type: 'trace-cli',
      displayName: 'TraeCode CLI',
      description: 'TraeCode CLI（经 traecli acp serve），默认只读问答',
    },
  ];
}

/** 全缺省配置：单机 127.0.0.1，无鉴权，opencode + pi 两个 agent */
export function defaultConfig(): GatewayConfig {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    auth: { enabled: false, token: '', sessionTtlDays: 7 },
    agents: defaultAgentDefinitions(),
    channels: {},
    plugins: [],
    weixin: { mode: 'weixin-bot' },
    tasks: { defaultAgentId: 'opencode' },
    defaultCwd: '',
  };
}
