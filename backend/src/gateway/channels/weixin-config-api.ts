import type { FastifyInstance } from 'fastify';
import type { AuthGuard } from '../users/auth.js';
import type { ProcessManager } from '../../supervisor/manager.js';
import type { SharedConfig } from '@linkagent/shared';
import {
  DEFAULT_WEIXIN_PLUGIN,
  persistWeixinChannelGatewaySetup,
  readWeixinChannelGatewayView,
} from '../../config/persist-weixin.js';
import { persistWeixinReceiveMode } from '../../config/persist.js';
import { weixinModeFromChannelGateway } from '@linkagent/shared';
import { buildChannelGatewayStatus } from './channel-gateway-status.js';

export interface WeixinConfigApiDeps {
  authGuard: AuthGuard;
  configPath: string;
  pm: ProcessManager;
  reloadConfig: () => SharedConfig;
  onConfigChanged?: (patch: Pick<SharedConfig, 'channelGateway'>) => void;
}

export function registerWeixinConfigApi(app: FastifyInstance, deps: WeixinConfigApiDeps): void {
  const { authGuard, configPath, pm, reloadConfig } = deps;

  const admin = (
    request: { ip?: string },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): boolean => {
    if (!authGuard.isAdmin(request as never)) {
      void reply.code(403).send({ error: '仅管理员可配置插件微信' });
      return false;
    }
    return true;
  };

  app.get('/api/channels/weixin', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!admin(request, reply)) return;
    const config = reloadConfig();
    const view = readWeixinChannelGatewayView(configPath);
    return {
      pluginPackage: DEFAULT_WEIXIN_PLUGIN,
      channelGateway: {
        enabled: view.channelGateway.enabled,
        weixin: view.channelGateway.weixin,
        weixinPlugin: view.channelGateway.weixinPlugin,
        model: view.channelGateway.model,
      },
      status: buildChannelGatewayStatus(config, pm),
    };
  });

  app.put('/api/channels/weixin', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!admin(request, reply)) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const cgBody = body.channelGateway;
    const cgRec =
      cgBody && typeof cgBody === 'object' && !Array.isArray(cgBody) ? (cgBody as Record<string, unknown>) : {};

    let weixin = cgRec.weixin === true || body.weixinEnabled === true;
    let weixinPlugin = cgRec.weixinPlugin === true || body.weixinPlugin === true;
    if (weixinPlugin && !weixin) weixin = true;
    if (!weixin) weixinPlugin = false;
    const enableCg = cgRec.enabled === true || weixin || weixinPlugin;
    const model = typeof cgRec.model === 'string' ? cgRec.model : undefined;
    const restart = body.restart !== false;
    const startOnly = body.startOnly === true;

    try {
      persistWeixinChannelGatewaySetup(configPath, {
        enabled: enableCg,
        weixin,
        weixinPlugin,
        model,
      });
      const receiveMode = weixinModeFromChannelGateway(weixin, weixinPlugin);
      if (receiveMode) {
        persistWeixinReceiveMode(configPath, receiveMode);
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const config = reloadConfig();
    deps.onConfigChanged?.({ channelGateway: config.channelGateway });

    if (restart && enableCg && (weixin || weixinPlugin)) {
      try {
        if (startOnly && !pm.isRunning('channels')) {
          await pm.start(['channels']);
        } else if (pm.isRunning('channels')) {
          await pm.restart(['channels']);
        } else {
          await pm.start(['channels']);
        }
      } catch (err) {
        return reply.code(500).send({
          error: `配置已保存，但 channels 进程启动失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const view = readWeixinChannelGatewayView(configPath);
    return {
      ok: true,
      channelGateway: {
        enabled: view.channelGateway.enabled,
        weixin: view.channelGateway.weixin,
        weixinPlugin: view.channelGateway.weixinPlugin,
        model: view.channelGateway.model,
      },
      status: buildChannelGatewayStatus(config, pm),
    };
  });
}
