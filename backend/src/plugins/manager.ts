/**
 * PluginManager —— openclaw 插件运行时宿主
 *
 * 职责：
 * 1. dynamic import 插件包（默认 @wecom/wecom-openclaw-plugin，可配置 plugins[].package）
 * 2. 构造 PluginRuntime(core) + PluginApi → plugin.register(api)
 * 3. 对每个注册的 channel：解析账号（listAccountIds/resolveAccount/isConfigured）
 *    → 调 channelPlugin.gateway.startAccount() 启动（Bot WS / Agent webhook）
 * 4. 把插件注册的 HTTP 路由挂到 Fastify
 * 5. agent 派发桥：core.channel.reply.dispatch → AgentManager → AcpWrapper（持久会话）
 */
import type { FastifyInstance } from 'fastify';
import { getLayout } from '../install/layout.js';
import type { AgentManager } from '../gateway/agents/manager.js';
import { createPluginRuntime, type PluginRuntime, type RuntimeLogger } from './runtime/core.js';
import { createPluginApi, type OpenClawPluginApi, type PluginApiCollector, type PluginChannelRegistration } from './runtime/api.js';
import { attachHttpRoutes } from './runtime/http.js';
import type { ChannelAgentDispatch } from './runtime/channel/reply.js';
import { mergePluginAccountStatus, type PluginAccountStatus } from './account-status.js';

/** pino（Fastify logger）duck-type */
export interface Logger {
  debug(obj: unknown, msg?: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface ChannelPluginHandle {
  id: string;
  name?: string;
  description?: string;
  config: {
    listAccountIds(cfg: Record<string, unknown>): string[];
    resolveAccount(cfg: Record<string, unknown>, accountId: string): Record<string, unknown>;
    defaultAccountId(cfg: Record<string, unknown>): string;
    isConfigured(account: Record<string, unknown>): boolean;
  };
  gateway: {
    startAccount(ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      /** resolveAccount 的账号对象（微信插件要求，含 token/botId 等） */
      account?: Record<string, unknown>;
      /** runtime.channel 面（微信插件要求 channelRuntime.commands 等） */
      channelRuntime?: PluginRuntime['channel'];
      log?: RuntimeLogger;
      runtime: PluginRuntime;
      abortSignal: AbortSignal;
      setStatus: (status: Record<string, unknown>) => void;
    }): Promise<unknown>;
  };
  messaging?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginPackageEntry {
  plugin: ChannelPluginHandle;
}

export interface PluginManagerOptions {
  /** 缺省派发用；channel-gateway 仅注入 agentDispatch 时可省略 */
  manager?: AgentManager;
  /** gateway 配置（channels 透传给插件） */
  config: Record<string, unknown>;
  stateDir: string;
  logger: Logger;
  /** writeConfigFile 持久化回调；缺省仅内存 */
  persistConfig?: (next: Record<string, unknown>) => boolean | Promise<boolean>;
  /** 覆盖默认 AgentManager 派发（channel-gateway 使用 /v1 SSE） */
  agentDispatch?: ChannelAgentDispatch;
  /** 是否挂载插件 HTTP（webhook）；false 时仅 WS/出站，不对外开回调路由 */
  attachHttpRoutes?: boolean;
}

export type AccountStatus = PluginAccountStatus;

export class PluginManager {
  private readonly manager: AgentManager | undefined;
  private readonly config: Record<string, unknown>;
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly persistConfig?: (next: Record<string, unknown>) => boolean | Promise<boolean>;
  private readonly agentDispatchOverride?: ChannelAgentDispatch;
  private readonly attachHttpRoutes: boolean;
  private runtime: PluginRuntime | null = null;
  private api: OpenClawPluginApi | null = null;
  private channelHandles = new Map<string, ChannelPluginHandle>();
  private readonly abortControllers: AbortController[] = [];
  private readonly accountStatuses = new Map<string, AccountStatus>();
  private started = false;

  constructor(options: PluginManagerOptions) {
    this.manager = options.manager;
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.logger = options.logger;
    this.persistConfig = options.persistConfig;
    this.agentDispatchOverride = options.agentDispatch;
    this.attachHttpRoutes = options.attachHttpRoutes !== false;
  }

  get accountStatus(): ReadonlyMap<string, AccountStatus> {
    return this.accountStatuses;
  }

  /** 插件包解析：配置 plugins[] 全部生效（enabled!==false），缺省官方企业微信插件 */
  private resolvePluginPackages(): string[] {
    const plugins = this.config.plugins as Array<{ package?: string; enabled?: boolean }> | undefined;
    const configured = (plugins ?? []).filter((p) => p.enabled !== false && p.package);
    const packages = configured.map((p) => p.package as string);
    return packages.length > 0 ? packages : ['@wecom/wecom-openclaw-plugin'];
  }

  /** 构造 openclaw 兼容配置（插件读取的面） */
  private buildPluginConfig(): Record<string, unknown> {
    const { channels, session, agents } = this.config as {
      channels?: Record<string, unknown>;
      session?: Record<string, unknown>;
      agents?: Record<string, unknown>;
    };
    return {
      ...(channels ? { channels } : {}),
      ...(session ? { session } : {}),
      ...(agents ? { agents } : {}),
      tools: { allow: [], deny: [] },
    };
  }

  private runtimeLogger(): RuntimeLogger {
    const logger = this.logger;
    return {
      debug: (msg, ...args) => logger.debug(msg, ...args),
      info: (msg, ...args) => logger.info(msg, ...args),
      warn: (msg, ...args) => logger.warn(msg, ...args),
      error: (msg, ...args) => logger.error(msg, ...args),
    };
  }

  /** agent 派发桥：dispatch → AgentManager → AcpWrapper（sessionKey 持久会话） */
  private createAgentDispatch(): ChannelAgentDispatch {
    const manager = this.manager;
    if (!manager) {
      throw new Error(
        'PluginManager 未配置 AgentManager 且无 agentDispatch 覆盖；channel-gateway 进程应传入 agentDispatch',
      );
    }
    return {
      async chat({ agentId, sessionKey, accountId, text, attachments }, cb) {
        const adapter = manager.resolve(agentId);
        if (!adapter) {
          const available = manager.listDescriptors().map((d) => d.id).join(', ');
          throw new Error(`渠道路由到 agent "${agentId}" 但未配置（可用：${available || '无'}）`);
        }
        // 附件以路径引用拼进 user 消息（一期文本为主；视觉理解依赖 agent 端 ACP 能力）
        let prompt = text;
        if (attachments?.length) {
          const refs = attachments.map((a) => `[附件: ${a.name} (${a.url})]`).join('\n');
          prompt = prompt ? `${prompt}\n\n${refs}` : refs;
        }
        await adapter.chat(
          {
            messages: [{ role: 'user', content: prompt }],
            sessionKey: `${accountId}::${sessionKey}`,
          },
          {
            onText: (delta) => cb.onText(delta),
            onReasoning: (delta) => cb.onReasoning?.(delta),
            onToolActivity: (name) => cb.onToolActivity?.(name),
          },
        );
      },
    };
  }

  /** 微信插件无 exports/main（根只有 index.ts），动态 import 需指向 dist/index.js */
  private static async importPlugin(pkg: string): Promise<unknown> {
    try {
      return await import(pkg);
    } catch (err) {
      const first = err;
      try {
        return await import(`${pkg}/dist/index.js`);
      } catch {
        throw first;
      }
    }
  }

  async start(app?: FastifyInstance): Promise<void> {
    if (this.started) return;
    const pluginPackages = this.resolvePluginPackages();

    const collector: PluginApiCollector = { channels: new Map(), httpRoutes: [], tools: [], hooks: [] };
    const pluginConfig = this.buildPluginConfig();
    const runtime = createPluginRuntime({
      stateDir: this.stateDir,
      config: pluginConfig,
      logger: this.runtimeLogger(),
      agentDispatch: this.agentDispatchOverride ?? this.createAgentDispatch(),
      persistConfig: this.persistConfig,
    });
    this.runtime = runtime;

    for (const pluginPackage of pluginPackages) {
      this.logger.info(`[plugins] 加载插件包 ${pluginPackage} ...`);
      const mod = (await PluginManager.importPlugin(pluginPackage)) as { default?: unknown; [key: string]: unknown };
      const plugin = (mod.default ?? mod) as {
        id?: string;
        name?: string;
        description?: string;
        version?: string;
        register(api: OpenClawPluginApi): void;
      };
      if (typeof plugin.register !== 'function') {
        throw new Error(`插件包 ${pluginPackage} 无 register() 入口（default export 应为插件对象）`);
      }

      const api = createPluginApi({
        pluginId: plugin.id ?? 'plugin',
        name: plugin.name ?? 'plugin',
        version: plugin.version ?? '0.0.0',
        description: plugin.description,
        config: pluginConfig,
        runtime,
        logger: this.runtimeLogger(),
        collector,
      });
      plugin.register(api);
      this.logger.info(
        `[plugins] ${plugin.id ?? 'plugin'} 注册完成：${collector.channels.size} 渠道 / ${collector.httpRoutes.length} 路由 / ${collector.tools.length} 工具 / ${collector.hooks.length} hooks`,
      );
    }

    // 启动每个注册渠道的账号
    for (const [channelId, registration] of collector.channels) {
      const entry = registration as unknown as PluginPackageEntry;
      const channelPlugin = entry.plugin;
      if (!channelPlugin) {
        this.logger.warn(`[plugins] channel "${channelId}" 注册对象缺少 plugin 字段，跳过`);
        continue;
      }
      this.channelHandles.set(channelId, channelPlugin);
      await this.startChannelAccounts(channelId, channelPlugin, runtime);
    }

    if (collector.httpRoutes.length > 0) {
      if (this.attachHttpRoutes) {
        if (!app) {
          throw new Error('挂载插件 HTTP 路由需要 Fastify 实例');
        }
        attachHttpRoutes(app, collector.httpRoutes);
        this.logger.info(`[plugins] 已挂载 ${collector.httpRoutes.length} 条插件 HTTP 路由`);
      } else {
        this.logger.info(
          `[plugins] exposePluginRoutes=false，跳过 ${collector.httpRoutes.length} 条 HTTP 路由（WebSocket/推送到 gateway）`,
        );
      }
    }

    this.started = true;
  }

  private async startChannelAccounts(
    channelId: string,
    channelPlugin: ChannelPluginHandle,
    runtime: PluginRuntime,
  ): Promise<void> {
    const cfg = this.buildPluginConfig();
    const configApi = channelPlugin.config;
    const list = configApi?.listAccountIds?.(cfg) ?? [];
    const ids = list.length > 0 ? list : configApi?.defaultAccountId ? [configApi.defaultAccountId(cfg)] : ['default'];
    for (const accountId of ids) {
      const account = configApi?.resolveAccount(cfg, accountId) ?? {};
      if (account.enabled === false) {
        this.logger.info(`[plugins] ${channelId}[${accountId}] disabled，跳过`);
        continue;
      }
      if (!configApi?.isConfigured?.(account)) {
        this.logger.warn(
          `[plugins] ${channelId}[${accountId}] 未配置或未登录，跳过（企业微信需 channels.<id>.botId+secret；个人微信需先扫码登录：${getLayout().loginHint}）`,
        );
        continue;
      }
      const abortController = new AbortController();
      this.abortControllers.push(abortController);
      const statusKey = `${channelId}:${accountId}`;
      const setStatus = (status: Record<string, unknown>): void => {
        this.accountStatuses.set(statusKey, mergePluginAccountStatus(this.accountStatuses.get(statusKey), status));
      };
      const log = this.runtimeLogger();
      const start = channelPlugin.gateway.startAccount({
        cfg,
        accountId,
        account,
        channelRuntime: runtime.channel,
        log,
        runtime,
        abortSignal: abortController.signal,
        setStatus,
      });
      // startAccount 的 promise 可能代表长驻任务（Bot WS monitor），不阻塞启动流程
      void Promise.resolve(start).catch((err: unknown) => {
        this.logger.error(`[plugins] ${channelId}[${accountId}] startAccount 失败: ${err instanceof Error ? err.message : String(err)}`);
        setStatus({ running: false, lastError: err instanceof Error ? err.message : String(err) });
      });
      // 企微 WS 路径认证成功不会 setStatus(running:true)（仅 webhook 会），先登记账号避免运行态 pluginAccounts 为空
      setStatus({ running: true, lastError: null, lastStartAt: Date.now() });
      this.logger.info(`[plugins] ${channelId}[${accountId}] startAccount 已发起（abort 可停止）`);
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.length = 0;
    this.started = false;
    this.logger.info('[plugins] 插件账号已全部停止');
  }
}
