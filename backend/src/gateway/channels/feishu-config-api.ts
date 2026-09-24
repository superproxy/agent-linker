import type { FastifyInstance } from 'fastify';
import type { AuthGuard } from '../users/auth.js';
import type { ProcessManager } from '../../supervisor/manager.js';
import {
  DEFAULT_FEISHU_PLUGIN,
  maskSecret,
  persistFeishuChannelSetup,
  readFeishuConfigView,
  readFeishuCredentials,
  type FeishuConnectionMode,
} from '../../config/persist-feishu.js';
import type { SharedConfig } from '@linkagent/shared';
import { buildChannelGatewayStatus } from './channel-gateway-status.js';

export interface FeishuConfigApiDeps {
  authGuard: AuthGuard;
  configPath: string;
  pm: ProcessManager;
  reloadConfig: () => SharedConfig;
  onConfigChanged?: (patch: Pick<SharedConfig, 'gateway' | 'channelGateway'>) => void;
}

export function registerFeishuConfigApi(app: FastifyInstance, deps: FeishuConfigApiDeps): void {
  const { authGuard, configPath, pm, reloadConfig } = deps;

  app.get('/api/channels/feishu', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    const config = reloadConfig();
    const view = readFeishuConfigView(configPath);
    const cred = readFeishuCredentials(view.feishu);
    const enabled = view.feishu.enabled === true;
    const modeRaw = view.feishu.connectionMode;
    const connectionMode: FeishuConnectionMode = modeRaw === 'webhook' ? 'webhook' : 'websocket';
    return {
      enabled,
      appId: cred.appId,
      appSecret: maskSecret(cred.appSecret),
      connectionMode,
      pluginPackage: view.pluginPackage || DEFAULT_FEISHU_PLUGIN,
      channelGateway: {
        enabled: config.channelGateway.enabled,
        feishu: config.channelGateway.feishu,
        feishuPluginPackage: config.channelGateway.feishuPluginPackage,
        model: config.channelGateway.model,
        server: config.channelGateway.server,
      },
      status: buildChannelGatewayStatus(config, pm),
    };
  });

  app.put('/api/channels/feishu', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const enabled = body.enabled === true;
    const appId = typeof body.appId === 'string' ? body.appId : '';
    const appSecret = typeof body.appSecret === 'string' ? body.appSecret : '';
    const connectionMode: FeishuConnectionMode = body.connectionMode === 'webhook' ? 'webhook' : 'websocket';
    const pluginPackage = typeof body.pluginPackage === 'string' ? body.pluginPackage : DEFAULT_FEISHU_PLUGIN;
    const verificationToken = typeof body.verificationToken === 'string' ? body.verificationToken : undefined;
    const encryptKey = typeof body.encryptKey === 'string' ? body.encryptKey : undefined;

    const cgBody = body.channelGateway;
    const cgRec =
      cgBody && typeof cgBody === 'object' && !Array.isArray(cgBody) ? (cgBody as Record<string, unknown>) : {};
    const serverRec =
      cgRec.server && typeof cgRec.server === 'object' && !Array.isArray(cgRec.server)
        ? (cgRec.server as Record<string, unknown>)
        : {};
    const enableCg = cgRec.enabled === true || enabled;
    const model = typeof cgRec.model === 'string' ? cgRec.model : undefined;
    const serverHost = typeof serverRec.host === 'string' ? serverRec.host : undefined;
    const serverPort = typeof serverRec.port === 'number' ? serverRec.port : undefined;

    const restart = body.restart !== false;

    try {
      persistFeishuChannelSetup(
        configPath,
        { enabled, appId, appSecret, connectionMode, pluginPackage, verificationToken, encryptKey },
        {
          enabled: enableCg,
          feishu: enabled,
          feishuPluginPackage: pluginPackage.trim() || DEFAULT_FEISHU_PLUGIN,
          model,
          serverHost,
          serverPort,
        },
      );
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const config = reloadConfig();
    deps.onConfigChanged?.({
      gateway: config.gateway,
      channelGateway: config.channelGateway,
    });

    if (restart && enableCg) {
      try {
        if (pm.isRunning('channels')) {
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

    const view = readFeishuConfigView(configPath);
    const cred = readFeishuCredentials(view.feishu);
    return {
      ok: true,
      enabled: view.feishu.enabled === true,
      appId: cred.appId,
      appSecret: maskSecret(cred.appSecret),
      channelGateway: config.channelGateway,
      status: buildChannelGatewayStatus(config, pm),
    };
  });
}
