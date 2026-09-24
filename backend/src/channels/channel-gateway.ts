/**
 * channel-gateway 进程：微信 ilink bot、企微智能机器人长连接、飞书官方长连接。
 * 不加载 OpenClaw 渠道插件。对话统一 SSE 回连主 gateway /v1。
 * 运行态推送到主 gateway，本进程不挂插件 HTTP。
 */
import { getLayout } from '../install/layout.js';
import { loadSharedConfig, resolveChildRuntime } from '../config/index.js';
import type { Logger } from '../plugins/manager.js';
import { readFeishuCredentials } from '../config/persist-feishu.js';
import { startWeixinBot, type WeixinBotHandle } from './weixin-bot.js';
import { startWecomAibot, type WecomAibotHandle } from './wecom-aibot.js';
import { startFeishuBot, type FeishuBotHandle } from './feishu-bot.js';
import { isWeixinUserBound } from './weixin-binding.js';
import { weixinLoginStateDir } from './weixin-login-state.js';
import { HttpUserTokenProvider } from './user-token.js';
import { LOCAL_CHANNEL_OWNER, resolveWecomOwnerUsername } from './wecom-owner.js';
import { startRuntimePushLoop } from './channel-gateway-push.js';
import { appendChannelGatewayLog } from './channel-gateway-log-buffer.js';
import { setChannelDispatchTraceSink } from '../store/dispatch-trace.js';
import type { ChannelGatewayPluginAccountReport } from '../store/channel-gateway-runtime-report.js';
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

function channelRecord(id: string): Record<string, unknown> {
  const raw = cg.channels[id];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function stringField(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  return typeof value === 'string' ? value.trim() : '';
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
    console.error('[channel-gateway] channelGateway.enabled=false，请在 channels.yaml 启用');
    process.exit(1);
  }

  const log = consoleLogger();
  if (cg.http.exposePluginRoutes) {
    log.info('已忽略 exposePluginRoutes：channels 不再挂载 OpenClaw 插件 HTTP');
  }
  if (cg.weixinPlugin) {
    log.warn('已忽略 weixinPlugin：个人微信只走 weixin-bot');
  }

  const loginAccounts = weixinAccountIds();
  const authMode = config.gateway.auth.mode;
  const localChannel = authMode === 'local';
  const channelBots = cg.wecom || cg.feishu;
  const ownerTokenProviders = new Map<string, HttpUserTokenProvider>();
  if (runtime.gatewayToken && channelBots && !localChannel) {
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
      log.info(`渠道用户 token 引导已注册 owner=${accountId}`);
    }
    if (loginAccounts.length === 0) {
      log.warn('weixin.accounts 为空：企微/飞书 /v1 将使用静态 gateway token，无 per-user ct_');
    }
  } else if (channelBots && localChannel) {
    log.info('auth.mode=local：企微/飞书 /v1 使用 gateway token，任务 owner=local');
  } else if (channelBots && !runtime.gatewayToken) {
    log.warn('未配置 gateway 静态 token：企微/飞书 /v1 匿名（auth.mode=open）或鉴权失败');
  }

  const ownerUsername = resolveWecomOwnerUsername(loginAccounts, cg.wecomOwner, log, authMode);
  const userTokenProvider = !localChannel && ownerUsername ? ownerTokenProviders.get(ownerUsername) : undefined;
  const model = cg.model || config.weixin.model || 'agent:pi';
  const channelAccounts: ChannelGatewayPluginAccountReport[] = [];

  const weixinHandles: WeixinBotHandle[] = [];
  let wecomHandle: WecomAibotHandle | null = null;
  let feishuHandle: FeishuBotHandle | null = null;

  if (cg.weixin) {
    const accounts = loginAccounts;
    if (accounts.length === 0) log.warn('weixin 已启用但 weixin.accounts 为空，跳过个人微信 bot');
    for (const accountId of accounts) {
      if (!isWeixinUserBound(weixinLoginStateDir(layout.pluginsState, accountId), accountId)) {
        log.warn(`跳过微信 bot：登录用户 ${accountId} 尚未扫码绑定`);
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
        log.error(`微信 bot 启动失败 account=${accountId}`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (cg.wecom) {
    const wecom = channelRecord('wecom');
    const status = { key: 'wecom', running: false, lastError: null as string | null };
    channelAccounts.push(status);
    if (wecom.enabled === false) {
      log.info('channels.wecom.enabled=false，跳过企微');
    } else if (wecom.connectionMode === 'webhook') {
      status.lastError = 'webhook 模式不在 channels 内启动，请改用 websocket（botId + secret）';
      log.error(status.lastError);
    } else {
      const botId = stringField(wecom, 'botId');
      const secret = stringField(wecom, 'secret');
      if (!botId || !secret) {
        status.lastError = '企微已启用但缺少 botId 或 secret';
        log.error(status.lastError);
      } else {
        try {
          wecomHandle = await startWecomAibot({
            botId,
            secret,
            gatewayUrl: runtime.gatewayUrl,
            gatewayToken: runtime.gatewayToken,
            model,
            ...(ownerUsername ? { ownerUsername } : {}),
            ...(userTokenProvider ? { userTokenProvider } : {}),
            log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
            errLog: (...args: unknown[]) => log.error(args.map(String).join(' ')),
          });
          status.running = true;
          log.info(`企微智能机器人已启动 botId=${botId}`);
        } catch (err) {
          status.lastError = err instanceof Error ? err.message : String(err);
          log.error('企微 bot 启动失败', status.lastError);
        }
      }
    }
  }

  if (cg.feishu) {
    const feishu = channelRecord('feishu');
    const status = { key: 'feishu', running: false, lastError: null as string | null };
    channelAccounts.push(status);
    if (feishu.enabled === false) {
      log.info('channels.feishu.enabled=false，跳过飞书');
    } else if (feishu.connectionMode === 'webhook') {
      status.lastError = '飞书 webhook 不在本进程启动，请使用 websocket 长连接';
      log.error(status.lastError);
    } else {
      const cred = readFeishuCredentials(feishu);
      const appSecret = typeof cred.appSecret === 'string' ? cred.appSecret.trim() : '';
      if (!cred.appId || !appSecret) {
        status.lastError = '飞书已启用但缺少 appId 或 appSecret';
        log.error(status.lastError);
      } else {
        try {
          feishuHandle = await startFeishuBot({
            appId: cred.appId,
            appSecret,
            gatewayUrl: runtime.gatewayUrl,
            gatewayToken: runtime.gatewayToken,
            model,
            ...(ownerUsername ? { ownerUsername } : {}),
            ...(userTokenProvider ? { userTokenProvider } : {}),
            log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
            errLog: (...args: unknown[]) => log.error(args.map(String).join(' ')),
          });
          status.running = true;
          log.info(`飞书长连接已启动 appId=${cred.appId}`);
        } catch (err) {
          status.lastError = err instanceof Error ? err.message : String(err);
          log.error('飞书 bot 启动失败', status.lastError);
        }
      }
    }
  }

  const started = weixinHandles.length > 0 || wecomHandle !== null || feishuHandle !== null;
  if (!started) {
    log.error('未启动任何渠道。请检查微信绑定、企微 botId/secret、飞书 appId/appSecret');
    process.exit(1);
  }

  log.info(`无 HTTP 检活/回调，运行态推送到 gateway ${runtime.gatewayUrl}`);

  let stopPush: (() => void) | undefined;
  if (cg.http.pushStatusToGateway) {
    stopPush = startRuntimePushLoop({
      gatewayUrl: runtime.gatewayUrl,
      gatewayToken: runtime.gatewayToken,
      intervalSec: cg.http.pushIntervalSec,
      exposePluginRoutes: false,
      listen: '(无 HTTP 服务)',
      weixinBotCount: weixinHandles.length,
      channelAccounts,
      log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
      errLog: (...args: unknown[]) => log.error(args.map(String).join(' ')),
    });
  }

  const shutdown = async (signal: string) => {
    log.info(`收到 ${signal}，退出…`);
    stopPush?.();
    for (const h of weixinHandles) await h.stop().catch(() => {});
    await wecomHandle?.stop().catch(() => {});
    await feishuHandle?.stop().catch(() => {});
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
