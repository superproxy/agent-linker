/**
 * channel-gateway 进程：微信 + 企微（OpenClaw 插件）+ 可选飞书插件；
 * 对话统一 SSE 回连主 gateway /v1。
 *
 * 默认不监听 HTTP（无 /healthz、无 webhook）；运行态推送到主 gateway。
 * 仅 channelGateway.http.exposePluginRoutes=true 时绑定 server 端口挂载插件回调。
 */
import Fastify from 'fastify';
import { getLayout } from '../install/layout.js';
import { loadSharedConfig, resolveChildRuntime } from '../config/index.js';
import { PluginManager, type Logger } from '../plugins/manager.js';
import { startWeixinBot, type WeixinBotHandle } from './weixin-bot.js';
import { isWeixinUserBound } from './weixin-binding.js';
import { weixinLoginStateDir } from './weixin-login-state.js';
import { DEFAULT_WEIXIN_PLUGIN } from '../config/persist-weixin.js';
import { HttpUserTokenProvider } from './user-token.js';
import { createV1AgentDispatch, TASK_ROUTED_MODEL_PLACEHOLDER } from './v1-agent-dispatch.js';
import { LOCAL_CHANNEL_OWNER, resolveWecomOwnerUsername } from './wecom-owner.js';
import { startRuntimePushLoop } from './channel-gateway-push.js';
import { appendChannelGatewayLog } from './channel-gateway-log-buffer.js';
import { setChannelDispatchTraceSink } from '../store/dispatch-trace.js';
import type { SharedConfig } from '@linkagent/shared';

const layout = getLayout();
const configPath = layout.configMode === 'none' ? undefined : layout.configFile;
const loaded = loadSharedConfig(configPath, layout.state('gateway'));
const config: SharedConfig = loaded.config;
const cg = config.channelGateway;
const runtime = resolveChildRuntime(config, {}, {}, layout.gatewayTokenFile);

function weixinAccountIds(): string[] {
  const fromYaml = config.weixin.accounts ?? [];
  const out: string[] = [];
  for (const a of fromYaml) {
    const t = a?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  const single = config.weixin.accountId?.trim();
  if (single && !out.includes(single)) out.push(single);
  return out;
}

function consoleLogger(): Logger {
  const formatExtra = (a: unknown): string => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return String(a);
    if (a === null || a === undefined) return '';
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const line = (level: string, msg: string, ...args: unknown[]) => {
    const extras = args
      .flatMap((a) => (Array.isArray(a) ? a : [a]))
      .map(formatExtra)
      .filter((s) => s.length > 0);
    const tail = extras.length ? ` ${extras.join(' ')}` : '';
    const formatted = `[channel-gateway] ${level} ${msg}${tail}`;
    console.log(formatted);
    appendChannelGatewayLog(level, msg, extras);
  };
  const write = (level: string, a: unknown, b?: string, ...rest: unknown[]) => {
    if (typeof a === 'string') {
      line(level, a, ...(b !== undefined ? [b, ...rest] : rest));
      return;
    }
    const msg = typeof b === 'string' ? b : '';
    line(level, msg, a, ...rest);
  };
  return {
    debug: (a: unknown, b?: string, ...rest: unknown[]) => write('debug', a, b, ...rest),
    info: (a: unknown, b?: string, ...rest: unknown[]) => write('info', a, b, ...rest),
    warn: (a: unknown, b?: string, ...rest: unknown[]) => write('warn', a, b, ...rest),
    error: (a: unknown, b?: string, ...rest: unknown[]) => write('error', a, b, ...rest),
  };
}

async function main(): Promise<void> {
  setChannelDispatchTraceSink((line) => {
    appendChannelGatewayLog('trace', line);
    console.log(`[channel-gateway] trace ${line}`);
  });

  if (!cg.enabled) {
    console.error('[channel-gateway] channelGateway.enabled=false，请在 channels.yaml 启用或改用 bot:weixin / gateway 内嵌模式');
    process.exit(1);
  }

  const exposeHttp = cg.http.exposePluginRoutes;
  const log = consoleLogger();
  const httpApp = exposeHttp ? Fastify({ logger: true }) : null;

  const loginAccounts = weixinAccountIds();
  const authMode = config.gateway.auth.mode;
  const localChannel = authMode === 'local';
  const ownerTokenProviders = new Map<string, HttpUserTokenProvider>();
  // local：渠道用户 ≡ local，对接只用 gateway token，不签 ct_
  if (runtime.gatewayToken && cg.wecom && !localChannel) {
    for (const accountId of loginAccounts) {
      ownerTokenProviders.set(
        accountId,
        new HttpUserTokenProvider({
          gatewayUrl: runtime.gatewayUrl,
          gatewayToken: runtime.gatewayToken,
          stateDir: layout.pluginsState,
          accountId,
          log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
        }),
      );
      log.info(`企微用户 token 引导已注册 owner=${accountId}（与微信 accounts 对齐）`);
    }
    if (loginAccounts.length === 0) {
      log.warn(
        'weixin.accounts 为空：企微 /v1 将使用静态 gateway token，无 per-user ct_（请在 overlay 登记登录用户）',
      );
    }
  } else if (cg.wecom && localChannel) {
    log.info('auth.mode=local：企微 /v1 使用 gateway token，任务 owner=local');
  } else if (cg.wecom && !runtime.gatewayToken) {
    log.warn('未配置 gateway 静态 token：企微 /v1 匿名（auth.mode=open）或鉴权失败');
  }

  const wecomOwner = resolveWecomOwnerUsername(loginAccounts, cg.wecomOwner, log, authMode);
  const wecomUserTokenProvider =
    !localChannel && wecomOwner ? ownerTokenProviders.get(wecomOwner) : undefined;

  const agentDispatch = createV1AgentDispatch({
    gatewayUrl: runtime.gatewayUrl,
    gatewayToken: runtime.gatewayToken,
    legacyModel: cg.model || config.weixin.model || TASK_ROUTED_MODEL_PLACEHOLDER,
    ...(wecomOwner ? { ownerUsername: wecomOwner } : {}),
    ...(wecomUserTokenProvider ? { userTokenProvider: wecomUserTokenProvider } : {}),
    onDispatchError: ({ sessionKey, err }) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`企微/插件消息派发失败 sessionKey=${sessionKey}: ${msg}`);
    },
  });

  const gwSection = config.gateway;
  const openClawChannels = { ...gwSection.channels, ...cg.channels };
  const openClawPlugins = cg.plugins.length > 0 ? cg.plugins : gwSection.plugins;
  const pluginConfig = {
    ...gwSection,
    plugins: openClawPlugins,
    channels: openClawChannels,
  } as Record<string, unknown>;

  const weixinHandles: WeixinBotHandle[] = [];
  let pluginManager: PluginManager | null = null;

  const useWeixinPlugin = cg.weixin && cg.weixinPlugin;
  const needsPluginRuntime =
    cg.wecom || cg.feishu || useWeixinPlugin || Object.keys(openClawChannels).length > 0;

  if (needsPluginRuntime) {
    const boundForPlugin = loginAccounts.filter((id) =>
      isWeixinUserBound(weixinLoginStateDir(layout.pluginsState, id), id),
    );
    if (useWeixinPlugin && boundForPlugin.length > 0) {
      const primary = boundForPlugin[0];
      if (primary === undefined) {
        process.env.OPENCLAW_STATE_DIR = layout.pluginsState;
      } else {
        process.env.OPENCLAW_STATE_DIR = weixinLoginStateDir(layout.pluginsState, primary);
        if (boundForPlugin.length > 1) {
          log.warn(
            `插件微信 OPENCLAW_STATE_DIR 使用首个已绑定账号 ${primary}（共 ${boundForPlugin.length} 个；多账号请用 weixin-bot 或分实例）`,
          );
        } else {
          log.info(`插件微信 OPENCLAW_STATE_DIR=${process.env.OPENCLAW_STATE_DIR}`);
        }
      }
    } else {
      process.env.OPENCLAW_STATE_DIR = layout.pluginsState;
      if (useWeixinPlugin && boundForPlugin.length === 0) {
        log.warn('插件微信已启用但无已绑定登录用户，扫码绑定后重启 channels');
      }
    }
    const packages = new Set<string>();
    if (cg.wecom) {
      for (const p of openClawPlugins) {
        const pkg = p.package?.trim();
        if (p.enabled === false || !pkg) continue;
        // weixinPlugin=false 时不随企微加载个人微信插件，收发走 ilink bot
        if (!useWeixinPlugin && pkg === DEFAULT_WEIXIN_PLUGIN) continue;
        packages.add(pkg);
      }
      if (packages.size === 0) packages.add('@wecom/wecom-openclaw-plugin');
    }
    if (cg.feishu && cg.feishuPluginPackage.trim()) {
      packages.add(cg.feishuPluginPackage.trim());
    }
    if (useWeixinPlugin) {
      packages.add(DEFAULT_WEIXIN_PLUGIN);
    }
    if (packages.size === 0) {
      for (const p of openClawPlugins) {
        if (p.enabled !== false && p.package?.trim()) packages.add(p.package.trim());
      }
    }
    pluginConfig.plugins = [...packages].map((packageName) => ({ package: packageName, enabled: true }));

    pluginManager = new PluginManager({
      config: pluginConfig,
      stateDir: layout.pluginsState,
      logger: httpApp ? (httpApp.log as never) : log,
      agentDispatch,
      attachHttpRoutes: exposeHttp,
    });
    try {
      await pluginManager.start(httpApp ?? undefined);
      log.info('OpenClaw 插件运行时已启动（派发 → /v1 SSE）');
    } catch (err) {
      log.error('插件启动失败', err instanceof Error ? err.message : String(err));
      await pluginManager.dispose().catch(() => {});
      pluginManager = null;
    }
  }

  if (cg.weixin && !cg.weixinPlugin) {
    const accounts = loginAccounts;
    if (accounts.length === 0) {
      log.warn('weixin 已启用但 weixin.accounts 为空，跳过个人微信 bot');
    }
    for (const accountId of accounts) {
      if (!isWeixinUserBound(weixinLoginStateDir(layout.pluginsState, accountId), accountId)) {
        log.warn(
          `跳过微信 bot：登录用户 ${accountId} 尚未扫码绑定（不影响企微 WebSocket；绑定后重启 channels）`,
        );
        continue;
      }
      try {
        const tokenProvider =
          !localChannel && runtime.gatewayToken
            ? new HttpUserTokenProvider({
                gatewayUrl: runtime.gatewayUrl,
                gatewayToken: runtime.gatewayToken,
                stateDir: layout.pluginsState,
                accountId,
                log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
              })
            : undefined;
        const handle = await startWeixinBot({
          gatewayUrl: runtime.gatewayUrl,
          gatewayToken: runtime.gatewayToken,
          model: config.weixin.model || cg.model,
          accountId,
          stateDir: layout.pluginsState,
          ...(localChannel
            ? { ownerUsername: LOCAL_CHANNEL_OWNER, gatewayTokenOnly: true }
            : tokenProvider
              ? { userTokenProvider: tokenProvider }
              : {}),
          log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
          errLog: (...args: unknown[]) => log.error(args.map(String).join(' ')),
        });
        weixinHandles.push(handle);
        log.info(`个人微信 bot 已启动 account=${accountId} bot=${handle.account.id}`);
      } catch (err) {
        log.error(
          `微信 bot 启动失败 account=${accountId}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const hasWecom = pluginManager !== null;
  if (!hasWecom && weixinHandles.length === 0) {
    log.error('未启动任何渠道（企微插件失败且无可用的微信绑定）；请检查 channels.yaml / 绑定 / botId+secret');
    process.exit(1);
  }

  let listenLabel = '(无 HTTP 服务)';
  if (exposeHttp && httpApp) {
    const host = cg.server.host;
    const port = cg.server.port;
    await httpApp.listen({ host, port });
    listenLabel = `${host}:${port}`;
    log.info(`插件 HTTP 监听 http://${listenLabel}，回连 gateway ${runtime.gatewayUrl}`);
  } else {
    log.info(`无 HTTP 检活/回调，运行态推送到 gateway ${runtime.gatewayUrl}`);
  }

  let stopPush: (() => void) | undefined;
  if (cg.http.pushStatusToGateway) {
    stopPush = startRuntimePushLoop({
      gatewayUrl: runtime.gatewayUrl,
      gatewayToken: runtime.gatewayToken,
      intervalSec: cg.http.pushIntervalSec,
      exposePluginRoutes: exposeHttp,
      listen: listenLabel,
      weixinBotCount: weixinHandles.length,
      pluginManager,
      log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
      errLog: (...args: unknown[]) => log.error(args.map(String).join(' ')),
    });
  }

  const shutdown = async (signal: string) => {
    log.info(`收到 ${signal}，退出…`);
    stopPush?.();
    for (const h of weixinHandles) await h.stop().catch(() => {});
    await pluginManager?.dispose().catch(() => {});
    await httpApp?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && /channel-gateway\.(ts|mjs|js|cjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('[channel-gateway] 启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main as startChannelGateway };
