/**
 * OpenClawPluginApi —— register(api) 收到的 api 对象（精简实现）
 *
 * 收集 registerChannel / registerHttpRoute / registerTool / on(hook) 的注册，
 * 供 PluginManager 在 register 后驱动账号启动与 HTTP 路由挂载。
 */
import type { PluginRuntime, RuntimeLogger } from './core.js';

export interface PluginHttpRouteRegistration {
  path: string;
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean | void> | boolean | void;
  auth?: string;
  match?: 'exact' | 'prefix';
}

export interface PluginChannelRegistration {
  id: string;
  name?: string;
  description?: string;
  config?: unknown;
  configSchema?: unknown;
  messaging?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginToolRegistration {
  id?: string;
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export interface PluginHookRegistration {
  event: string;
  handler: (ctx: Record<string, unknown>) => unknown;
}

export interface PluginApiCollector {
  channels: Map<string, PluginChannelRegistration>;
  httpRoutes: PluginHttpRouteRegistration[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
}

export interface CreatePluginApiParams {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  source?: string;
  rootDir?: string;
  config: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  collector: PluginApiCollector;
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version: string;
  description?: string;
  source?: string;
  rootDir?: string;
  registrationMode: string;
  config: Record<string, unknown>;
  logger: RuntimeLogger;
  runtime: PluginRuntime;
  session: {
    setContext(_key: string, _value: unknown): void;
    getContext(_key: string): unknown;
    clearContext(): void;
  };
  registerChannel(registration: PluginChannelRegistration): void;
  registerHttpRoute(params: PluginHttpRouteRegistration): void;
  registerTool(tool: PluginToolRegistration, _opts?: unknown): void;
  on(event: string, handler: (ctx: Record<string, unknown>) => unknown): void;
  registerHook?(hook: PluginHookRegistration): void;
  // openclaw 其余注册面：一期不实现（记录 warn，不阻塞）
  registerService?(_svc: unknown): void;
  registerProvider?(_provider: unknown): void;
  registerCommand?(_cmd: unknown): void;
  registerMemoryProvider?(_provider: unknown): void;
  registerSetup?(_setup: unknown): void;
  registerAgentEventSubscription?(_sub: unknown): void;
}

export function createPluginApi(params: CreatePluginApiParams): OpenClawPluginApi {
  const { config, runtime, logger, collector } = params;
  const warnOnce = (label: string) => {
    let warned = false;
    return () => {
      if (!warned) {
        warned = true;
        logger.warn(`[plugin:${params.pluginId}] ${label} 暂未由 linkagent shim 实现，调用被忽略`);
      }
    };
  };
  return {
    id: params.pluginId,
    name: params.name,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    registrationMode: 'runtime',
    config,
    logger,
    runtime,
    session: {
      setContext: warnOnce('api.session.setContext'),
      getContext: warnOnce('api.session.getContext'),
      clearContext: warnOnce('api.session.clearContext'),
    },
    registerChannel(registration) {
      // 插件侧 registerChannel({ plugin: ChannelPlugin })，id 在 plugin.id（或 registration.id）
      const id = registration?.id ?? (registration as { plugin?: { id?: string } } | undefined)?.plugin?.id;
      if (!id) {
        logger.warn(`[plugin:${params.pluginId}] registerChannel 缺少 id，忽略`);
        return;
      }
      if (collector.channels.has(id)) {
        logger.warn(`[plugin:${params.pluginId}] channel "${id}" 重复注册，覆盖`);
      }
      collector.channels.set(id, registration);
      logger.info(`[plugin:${params.pluginId}] 注册渠道 channel "${id}"`);
    },
    registerHttpRoute(route) {
      if (!route?.path || typeof route.handler !== 'function') {
        logger.warn(`[plugin:${params.pluginId}] registerHttpRoute 缺少 path/handler，忽略`);
        return;
      }
      collector.httpRoutes.push(route);
      logger.info(`[plugin:${params.pluginId}] 注册 HTTP 路由 ${route.path} (match=${route.match ?? 'exact'})`);
    },
    registerTool(tool) {
      if (!tool) return;
      collector.tools.push(tool);
      logger.info(`[plugin:${params.pluginId}] 注册工具 ${(tool as { name?: string }).name ?? tool.id ?? '(anonymous)'}（一期不注入 agent，仅登记）`);
    },
    on(event, handler) {
      collector.hooks.push({ event, handler });
      logger.info(`[plugin:${params.pluginId}] 注册 hook "${event}"（linkagent 不运行 agent prompt 构建，hook 仅登记）`);
    },
    registerHook(hook) {
      this.on(hook.event, hook.handler);
    },
    registerService: warnOnce('api.registerService'),
    registerProvider: warnOnce('api.registerProvider'),
    registerCommand: warnOnce('api.registerCommand'),
    registerMemoryProvider: warnOnce('api.registerMemoryProvider'),
    registerSetup: warnOnce('api.registerSetup'),
    registerAgentEventSubscription: warnOnce('api.registerAgentEventSubscription'),
  };
}
