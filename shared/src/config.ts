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

/**
 * 鉴权模式：
 * - local（默认，本机）：回环请求免登录识别为「本机默认用户」；非回环必须携带永久 gateway token。
 * - token：强制令牌，任何来源（含本机浏览器）都需 gateway token 或账号会话，等同旧 enabled=true。
 * - open：完全不鉴权，等同旧 enabled=false（仅建议绑定回环）。
 */
export const AUTH_MODES = ['local', 'token', 'open'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const authConfigSchema = z
  .object({
    /** 鉴权模式（新字段）；旧布尔 enabled 由迁移层归一化 */
    mode: z.enum(AUTH_MODES).default('local'),
    /** gateway token（默认用户的永久凭据）；留空则首次启动自动生成并落盘 .runtime-state/gateway-token */
    token: z.string().default(''),
    /** 登录会话有效期（天），到期需重新登录；默认 7 天（token/local 模式下账号会话使用） */
    sessionTtlDays: z.number().positive().default(7),
  })
  .default({ mode: 'local', token: '', sessionTtlDays: 7 });
export type AuthConfig = z.infer<typeof authConfigSchema>;

/** gateway 进程段（原扁平配置整体收敛于此） */
export const gatewaySectionSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(8787),
    })
    .default({ host: '127.0.0.1', port: 8787 }),
  auth: authConfigSchema,
  agents: z.array(agentDefSchema).default([]),
  /** agent 默认工作目录：agent 未显式配 cwd 时用它作为 ACP 进程/会话的工作目录；缺省为空串（沿用网关启动目录） */
  defaultCwd: z.string().default(''),
  /** 预留：渠道配置（微信等）二期接入 */
  channels: z.record(z.string(), z.unknown()).default({}),
  /** openclaw 渠道插件包（企业微信默认内置；个人微信 @tencent-weixin/openclaw-weixin） */
  plugins: z
    .array(z.object({ package: z.string().min(1), enabled: z.boolean().default(true) }))
    .default([]),
  /** 任务公共能力（多渠道共享）：默认任务绑定的 agent（缺省 opencode） */
  tasks: z
    .object({
      defaultAgentId: z.string().default('opencode'),
      /** 任务工作空间根目录：配置后每个任务默认独立目录 <root>/<userId>/<taskId>（任务间隔离） */
      workspaceDir: z.string().optional(),
    })
    .default({ defaultAgentId: 'opencode' }),
});
export type GatewaySection = z.infer<typeof gatewaySectionSchema>;

/**
 * weixin 进程段（个人微信 bot 独立进程 / gateway 内嵌共用）。
 * mode 仅影响 gateway 是否内嵌 bot：默认 weixin-bot（单跑 gateway 内嵌）；
 * 进程管理器托管时经 LINKAGENT_WEIXIN_MODE=external 覆盖，不在配置里强制。
 */
export const weixinSectionSchema = z
  .object({
    /** pm start all 时是否拉起该进程（默认 true） */
    enabled: z.boolean().default(true),
    /**
     * weixin-bot：gateway 进程内拉起（默认，单跑 gateway 时）
     * openclaw-weixin-plugin：openclaw 插件运行时
     * external：独立进程（进程管理器托管）
     */
    mode: z.enum(['weixin-bot', 'openclaw-weixin-plugin', 'external']).default('weixin-bot'),
    /** 登录态账号 id（缺省取 accounts/ 下第一个） */
    accountId: z.string().default(''),
    /** 对话模型（默认 agent:pi） */
    model: z.string().default('agent:pi'),
    /** 网关 base；缺省由 gateway.server 推导（0.0.0.0/:: 归一化到 127.0.0.1） */
    gatewayUrl: z.string().default(''),
    /** 回连网关的永久 token；缺省取 gateway.auth.token 或自动生成的 gateway-token */
    gatewayToken: z.string().default(''),
  })
  .default({ enabled: true, mode: 'weixin-bot', accountId: '', model: 'agent:pi', gatewayUrl: '', gatewayToken: '' });
export type WeixinSection = z.infer<typeof weixinSectionSchema>;

/** node（executor）执行器进程段：本机/远程节点连接器 */
export const nodeSectionSchema = z
  .object({
    /** pm start all 时是否拉起该进程（默认 true） */
    enabled: z.boolean().default(true),
    /** 节点展示名（缺省 node-<hostname>） */
    name: z.string().default(''),
    /** 上报的 agent id 列表（空 = 网关默认 4 种：opencode/pi/workbuddy/trace-cli） */
    agents: z.array(z.string()).default([]),
    /** 网关地址；缺省由 gateway.server 推导 */
    gatewayUrl: z.string().default(''),
    /** 回连网关的永久 token；缺省取 gateway.auth.token 或自动生成的 gateway-token */
    gatewayToken: z.string().default(''),
  })
  .default({ enabled: true, name: '', agents: [], gatewayUrl: '', gatewayToken: '' });
export type NodeSection = z.infer<typeof nodeSectionSchema>;

/** 三进程共享配置文件 config.yaml 的新结构（gateway / weixin / node 三段） */
export const sharedConfigSchema = z.object({
  gateway: gatewaySectionSchema,
  weixin: weixinSectionSchema,
  node: nodeSectionSchema,
});
export type SharedConfig = z.infer<typeof sharedConfigSchema>;

/**
 * 旧扁平结构（顶层 server/auth/agents/...，含 weixin 子段）。
 * 仅用于迁移期识别与解析，业务代码统一使用 {@link SharedConfig}。
 */
const legacyConfigSchema = z
  .object({
    server: z.object({ host: z.string().optional(), port: z.number().optional() }).optional(),
    auth: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(AUTH_MODES).optional(),
        token: z.string().optional(),
        sessionTtlDays: z.number().optional(),
      })
      .optional(),
    agents: z.array(agentDefSchema).optional(),
    defaultCwd: z.string().optional(),
    channels: z.record(z.string(), z.unknown()).optional(),
    plugins: z.array(z.object({ package: z.string().min(1), enabled: z.boolean().optional() })).optional(),
    tasks: z.object({ defaultAgentId: z.string().optional(), workspaceDir: z.string().optional() }).optional(),
    weixin: z
      .object({
        mode: z.enum(['weixin-bot', 'openclaw-weixin-plugin', 'external']).optional(),
        accountId: z.string().optional(),
        model: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function isNewShape(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && 'gateway' in (raw as Record<string, unknown>);
}

/**
 * 把任意 yaml 原始内容归一化为三段式 {@link SharedConfig}：
 * - 已是三段式：直接解析；
 * - 旧扁平格式：顶层字段收进 gateway 段，旧 weixin.* 映射到新 weixin 段，auth.enabled→mode。
 */
export function migrateConfig(raw: unknown): SharedConfig {
  if (isNewShape(raw)) {
    return sharedConfigSchema.parse(raw);
  }
  const legacy = legacyConfigSchema.parse(raw ?? {});

  // auth.enabled(false)→open；enabled(true)→token；仅给了 mode 时尊重 mode；都没有→local
  const mode: AuthMode =
    legacy.auth?.mode ?? (legacy.auth?.enabled === false ? 'open' : legacy.auth?.enabled === true ? 'token' : 'local');

  const gateway = gatewaySectionSchema.parse({
    ...(legacy.server ? { server: legacy.server } : {}),
    auth: {
      mode,
      ...(legacy.auth?.token !== undefined ? { token: legacy.auth.token } : {}),
      ...(legacy.auth?.sessionTtlDays !== undefined ? { sessionTtlDays: legacy.auth.sessionTtlDays } : {}),
    },
    ...(legacy.agents ? { agents: legacy.agents } : {}),
    ...(legacy.defaultCwd !== undefined ? { defaultCwd: legacy.defaultCwd } : {}),
    ...(legacy.channels ? { channels: legacy.channels } : {}),
    ...(legacy.plugins ? { plugins: legacy.plugins } : {}),
    ...(legacy.tasks ? { tasks: legacy.tasks } : {}),
  });

  const weixin = weixinSectionSchema.parse({
    ...(legacy.weixin?.mode ? { mode: legacy.weixin.mode } : {}),
    ...(legacy.weixin?.accountId ? { accountId: legacy.weixin.accountId } : {}),
    ...(legacy.weixin?.model ? { model: legacy.weixin.model } : {}),
  });

  return { gateway, weixin, node: nodeSectionSchema.parse({}) };
}

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

/** 全缺省三段式配置：本机 local 鉴权、127.0.0.1:8787，内置默认 agent */
export function defaultSharedConfig(): SharedConfig {
  return migrateConfig({
    server: { host: '127.0.0.1', port: 8787 },
    auth: { mode: 'local', token: '', sessionTtlDays: 7 },
    agents: defaultAgentDefinitions(),
    channels: {},
    plugins: [],
    tasks: { defaultAgentId: 'opencode' },
    defaultCwd: '',
  });
}

// ── 向后兼容别名：迁移期保留旧类型/默认值导出名，减少调用方改动面 ──

/** @deprecated 改用 {@link SharedConfig} 的 gateway 段；保留供旧调用方引用 */
export interface GatewayConfig {
  server: GatewaySection['server'];
  auth: LegacyAuthShape;
  agents: GatewaySection['agents'];
  defaultCwd: string;
  channels: GatewaySection['channels'];
  plugins: GatewaySection['plugins'];
  weixin: { mode: WeixinSection['mode']; accountId?: string; model?: string };
  tasks: GatewaySection['tasks'];
}

/** @deprecated 旧布尔鉴权形态 */
export interface LegacyAuthShape {
  enabled: boolean;
  token: string;
  sessionTtlDays: number;
}

/**
 * @deprecated 旧扁平配置解析（内部走迁移层后还原为旧形状）。
 * 新代码请用 loadSharedConfig；保留以兼容既有测试/调用方。
 */
export const gatewayConfigSchema = z
  .any()
  .transform((raw) => {
    const cfg = migrateConfig(raw);
    return {
      server: cfg.gateway.server,
      auth: {
        enabled: cfg.gateway.auth.mode === 'token',
        token: cfg.gateway.auth.token,
        sessionTtlDays: cfg.gateway.auth.sessionTtlDays,
      },
      agents: cfg.gateway.agents,
      defaultCwd: cfg.gateway.defaultCwd,
      channels: cfg.gateway.channels,
      plugins: cfg.gateway.plugins,
      weixin: {
        mode: cfg.weixin.mode,
        ...(cfg.weixin.accountId ? { accountId: cfg.weixin.accountId } : {}),
        ...(cfg.weixin.model ? { model: cfg.weixin.model } : {}),
      },
      tasks: cfg.gateway.tasks,
    } satisfies GatewayConfig;
  });

/** @deprecated 旧默认配置（扁平、enabled=false）；新代码用 {@link defaultSharedConfig} */
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
