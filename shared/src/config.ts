import { z } from 'zod';
import { ACP_AGENT_KINDS, ACP_PERMISSION_MODES, ACP_PERMISSION_POLICY_ACTIONS } from './adapter.js';
import { normalizeWeixinMode, type WeixinMode } from './weixin-mode.js';

export type { WeixinMode } from './weixin-mode.js';
export { normalizeWeixinMode, weixinModeUsesPlugin, channelGatewayFromWeixinMode, weixinModeFromChannelGateway } from './weixin-mode.js';

const weixinModeSchema = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeWeixinMode(v) : v),
  z.enum(['raw', 'claw']).default('raw'),
);
import type { AgentDefinition } from './adapter.js';

export type { AcpPermissionMode, NonInteractivePermissionPolicy, PermissionPolicySpec, PermissionPolicyAction, AgentDefinition } from './adapter.js';

/** ACP 工具权限策略配置（对应 acpx createAcpRuntime 的 permissionPolicy） */
export const permissionPolicySchema = z
  .object({
    /** 命中即自动放行的工具名（支持精确/子串匹配） */
    autoApprove: z.array(z.string()).optional(),
    /** 命中即自动拒绝的工具名（优先级高于 autoApprove） */
    autoDeny: z.array(z.string()).optional(),
    /** 命中即升级为需审批的工具名（网关无审批 UI，等同拒绝） */
    escalate: z.array(z.string()).optional(),
    /** 未命中任何规则时的兜底动作 */
    defaultAction: z.enum(ACP_PERMISSION_POLICY_ACTIONS).optional(),
  })
  .optional();

export const agentDefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(ACP_AGENT_KINDS),
  displayName: z.string().optional(),
  description: z.string().optional(),
  cwd: z.string().optional(),
  // 缺省值在 AcpWrapper 侧兜底为 approve-reads（与 AgentDefinition.permissionMode 的 optional 一致）
  permissionMode: z.enum(ACP_PERMISSION_MODES).optional(),
  // ACP 工具权限策略（优先于 permissionMode）；所有渠道（/v1、微信/企微 bot、openclaw 插件）共用同一定义层
  permissionPolicy: permissionPolicySchema,
  env: z.record(z.string(), z.string()).optional(),
  command: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** 缺省启用；false 时启动不纳入 /v1 与任务路由 */
  enabled: z.boolean().optional(),
});

/**
 * 鉴权模式：
 * - local（默认）：按运行模式识别为「本机默认用户」（管理员），免登录；不区分访问地址。公网请用 token 模式。
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
  /** 任务公共能力（多渠道共享）：默认任务绑定的 agent（缺省 pi） */
  tasks: z
    .object({
      defaultAgentId: z.string().default('pi'),
      /** 任务工作空间根目录：配置后每个任务默认独立目录 <root>/<登录用户名>/<taskId>（按用户，不按微信联系人） */
      workspaceDir: z.string().optional(),
    })
    .default({ defaultAgentId: 'pi' }),
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
     * 个人微信一律由 channel-gateway（channels 进程）托管，gateway 不内嵌 bot。
     * raw：channels 内 weixin-bot（ilink，默认）
     * claw：channels 内 @tencent-weixin/openclaw-weixin 插件收发
     * 兼容旧值 external / weixin-bot → raw，openclaw-weixin-plugin → claw
     */
    mode: weixinModeSchema,
    /** 登录态账号 id（缺省取 accounts/ 下第一个） */
    accountId: z.string().default(''),
    /** 多账号：登录用户名列表；channel-gateway 进程内按账号拉起 bot/插件（非 weixin:<id> 多进程）。 */
    accounts: z.array(z.string().min(1)).default([]),
    /** 对话模型（默认 agent:pi） */
    model: z.string().default('agent:pi'),
    /** 网关 base；缺省由 gateway.server 推导（0.0.0.0/:: 归一化到 127.0.0.1） */
    gatewayUrl: z.string().default(''),
    /** 回连网关的永久 token；缺省取 gateway.auth.token 或自动生成的 gateway-token */
    gatewayToken: z.string().default(''),
  })
  .default({
    enabled: true,
    mode: 'raw',
    accountId: '',
    accounts: [],
    model: 'agent:pi',
    gatewayUrl: '',
    gatewayToken: '',
  });
export type WeixinSection = z.infer<typeof weixinSectionSchema>;

/** node.agents 单项：字符串 id 或带 ACP 权限的对象（仅节点连接器 / 远程执行生效） */
export const nodeAgentEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  permissionMode: z.enum(ACP_PERMISSION_MODES).optional(),
  permissionPolicy: permissionPolicySchema,
  /** ACP server 启动命令；缺省按 agent id 对应内置默认（见 backend acpEngine DEFAULT_COMMANDS） */
  command: z.array(z.string()).optional(),
  /** 透传给 ACP 子进程的额外环境变量 */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Cursor CLI 等经 `--key` 鉴权时使用的 API key（仅节点本机 spawn，hello 不上报）。
   * 未配 command 时会在默认 `agent acp` 后追加 `--key <key>`。
   */
  key: z.string().optional(),
});
export type NodeAgentConfigEntry = z.infer<typeof nodeAgentEntrySchema>;
export const nodeAgentListItemSchema = z.union([z.string().min(1), nodeAgentEntrySchema]);
export type NodeAgentListItem = z.infer<typeof nodeAgentListItemSchema>;

/** node（executor）执行器进程段：本机/远程节点连接器 */
export const nodeSectionSchema = z
  .object({
    /** pm start all 时是否拉起该进程（默认 true） */
    enabled: z.boolean().default(true),
    /** 节点展示名（缺省 node-<hostname>） */
    name: z.string().default(''),
    /**
     * 节点自报 agent 清单（空 = 内置默认 id 列表）。
     * 可为 id 字符串，或 { id, permissionMode?, permissionPolicy?, displayName?, command?, env?, key? }（ACP 权限与启动参数只在此段配置）。
     */
    agents: z.array(nodeAgentListItemSchema).default([]),
    /** 网关地址；缺省由 gateway.server 推导 */
    gatewayUrl: z.string().default(''),
    /** 回连网关的永久 token；缺省取 gateway.auth.token 或自动生成的 gateway-token */
    gatewayToken: z.string().default(''),
  })
  .default({ enabled: true, name: '', agents: [], gatewayUrl: '', gatewayToken: '' });
export type NodeSection = z.infer<typeof nodeSectionSchema>;

/**
 * channel-gateway 进程段：统一托管微信 / 企微 / 飞书渠道，对话回连主网关 /v1（SSE）。
 * enabled=true 时 supervisor 拉起 channels 进程，gateway 不再内嵌 weixin-bot / 插件运行时。
 */
export const channelGatewaySectionSchema = z
  .object({
    enabled: z.boolean().default(false),
    server: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().positive().default(8790),
      })
      .default({ host: '127.0.0.1', port: 8790 }),
    /**
     * HTTP 暴露策略：默认 exposePluginRoutes=false（无 HTTP 服务、无检活）；
     * 运行态推送到主 gateway，PM 以 pid 判断 channels 存活。
     */
    http: z
      .object({
        exposePluginRoutes: z.boolean().default(false),
        pushStatusToGateway: z.boolean().default(true),
        pushIntervalSec: z.number().int().min(5).default(30),
      })
      .default({ exposePluginRoutes: false, pushStatusToGateway: true, pushIntervalSec: 30 }),
    /** 主网关 base；缺省由 gateway.server 推导 */
    gatewayUrl: z.string().default(''),
    gatewayToken: z.string().default(''),
    /** 插件/OpenClaw 路由缺省 model（/v1 body.model） */
    model: z.string().default('agent:pi'),
    /** 进程内拉起个人微信（weixin-bot 或 openclaw 插件，见 weixinPlugin） */
    weixin: z.boolean().default(true),
    /** true：在 channels 内加载 @tencent-weixin/openclaw-weixin 收发；false：weixin-bot（ilink） */
    weixinPlugin: z.boolean().default(false),
    /** 加载 channelGateway.plugins / channels 中的企微 OpenClaw 插件 */
    wecom: z.boolean().default(true),
    /**
     * 企微任务空间 / ct_ 引导的 web 登录用户名（ownerUsername）。
     * 缺省时：LINKAGENT_ACCOUNT_ID → 唯一 weixin.accounts → 多账号时取第一个并 warn。
     */
    wecomOwner: z.string().default(''),
    /** 尝试加载 feishuPluginPackage */
    feishu: z.boolean().default(false),
    feishuPluginPackage: z.string().default(''),
    /** OpenClaw 渠道段（企微 botId/secret 等）；写在 channels.yaml，不写 gateway.yaml */
    channels: z.record(z.string(), z.unknown()).default({}),
    /** OpenClaw 插件包列表（企微等）；channel-gateway 进程读取 */
    plugins: z
      .array(z.object({ package: z.string().min(1), enabled: z.boolean().default(true) }))
      .default([]),
  })
  .default({
    enabled: false,
    server: { host: '127.0.0.1', port: 8790 },
    http: { exposePluginRoutes: false, pushStatusToGateway: true, pushIntervalSec: 30 },
    gatewayUrl: '',
    gatewayToken: '',
    model: 'agent:pi',
    weixin: true,
    weixinPlugin: false,
    wecom: true,
    wecomOwner: '',
    feishu: false,
    feishuPluginPackage: '',
    channels: {},
    plugins: [],
  });
export type ChannelGatewaySection = z.infer<typeof channelGatewaySectionSchema>;

/** 四段有效配置（gateway / weixin / channels / node yaml 合并） */
export const sharedConfigSchema = z.object({
  gateway: gatewaySectionSchema,
  weixin: weixinSectionSchema,
  channelGateway: channelGatewaySectionSchema,
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
        mode: weixinModeSchema.optional(),
        accountId: z.string().optional(),
        model: z.string().optional(),
        gatewayUrl: z.string().optional(),
        gatewayToken: z.string().optional(),
      })
      .optional(),
    node: z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        agents: z.array(nodeAgentListItemSchema).optional(),
        gatewayUrl: z.string().optional(),
        gatewayToken: z.string().optional(),
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
    ...(legacy.weixin?.gatewayUrl !== undefined ? { gatewayUrl: legacy.weixin.gatewayUrl } : {}),
    ...(legacy.weixin?.gatewayToken !== undefined ? { gatewayToken: legacy.weixin.gatewayToken } : {}),
  });

  const node = nodeSectionSchema.parse({
    ...(legacy.node?.enabled !== undefined ? { enabled: legacy.node.enabled } : {}),
    ...(legacy.node?.name ? { name: legacy.node.name } : {}),
    ...(legacy.node?.agents ? { agents: legacy.node.agents } : {}),
    ...(legacy.node?.gatewayUrl !== undefined ? { gatewayUrl: legacy.node.gatewayUrl } : {}),
    ...(legacy.node?.gatewayToken !== undefined ? { gatewayToken: legacy.node.gatewayToken } : {}),
  });

  const channelGateway = channelGatewaySectionSchema.parse({});

  return { gateway, weixin, channelGateway, node };
}

/**
 * 缺省 agent（无配置文件时可开箱即用）；pi 依赖本机已装 pi 与 pi-acp，
 * workbuddy 依赖本机已装 codebuddy（CodeBuddy Code CLI），trace-cli 依赖本机已装 traecli（TraeCode CLI），
 * cursor 依赖本机已装 Cursor CLI（`agent acp`）。
 * 对应 CLI 未安装时 gateway 仍正常启动（probe 仅标记 unhealthy），实际调用会报 ACP_BACKEND_UNAVAILABLE。
 * pi 默认不绑会话模型，沿用本机 ~/.pi/agent/settings.json（defaultProvider / defaultModel）。
 * 若要覆盖，在 config 的 agents[].model 写 ~/.pi/agent/models.json 里真实存在的 providerId/modelId。
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
    {
      id: 'cursor',
      type: 'cursor',
      displayName: 'Cursor',
      description: 'Cursor CLI（经 agent acp），默认只读问答',
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
    tasks: { defaultAgentId: 'pi' },
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
    weixin: { mode: 'raw' },
    tasks: { defaultAgentId: 'pi' },
    defaultCwd: '',
  };
}
