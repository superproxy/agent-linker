import type { FastifyInstance } from 'fastify';
import type { AuthGuard } from '../users/auth.js';
import type { ProcessManager } from '../../supervisor/manager.js';
import {
  DEFAULT_WECOM_PLUGIN,
  maskSecret,
  persistWecomChannelSetup,
  readWecomConfigView,
  type WecomConnectionMode,
} from '../../config/persist-wecom.js';
import type { SharedConfig } from '@linkagent/shared';
import { isLoopbackIp } from '../pm/api.js';
import {
  setChannelGatewayRuntimeReport,
  type ChannelGatewayRuntimeReport,
} from './runtime-report-store.js';
import { buildChannelGatewayStatus } from './channel-gateway-status.js';

export interface WecomConfigApiDeps {
  authGuard: AuthGuard;
  configPath: string;
  pm: ProcessManager;
  gatewayToken: string;
  authEnabled: boolean;
  /** 保存后同步内存配置 */
  onConfigChanged?: (patch: Pick<SharedConfig, 'gateway' | 'channelGateway'>) => void;
  reloadConfig: () => SharedConfig;
}

function bearerToken(request: { headers: { authorization?: string } }): string {
  const h = request.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1]?.trim() ?? '';
}

export function registerWecomConfigApi(app: FastifyInstance, deps: WecomConfigApiDeps): void {
  const { authGuard, configPath, pm, reloadConfig, gatewayToken, authEnabled } = deps;

  app.post('/api/channels/channel-gateway/report', async (request, reply) => {
    const body = request.body as ChannelGatewayRuntimeReport | null;
    if (!body || body.service !== 'channel-gateway') {
      return reply.code(400).send({ error: 'invalid report body' });
    }
    if (authEnabled) {
      const token = bearerToken(request);
      if (!token || token !== gatewayToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    } else if (!isLoopbackIp(request.ip)) {
      return reply.code(403).send({ error: 'open 模式仅允许本机推送运行态' });
    }
    setChannelGatewayRuntimeReport({
      ...body,
      reportedAt: body.reportedAt > 0 ? body.reportedAt : Date.now(),
    });
    return { ok: true };
  });

  app.get('/api/channels/wecom', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    const config = reloadConfig();
    const view = readWecomConfigView(configPath);
    const secret = maskSecret(view.wecom.secret);
    const enabled = view.wecom.enabled === true;
    return {
      enabled,
      botId: typeof view.wecom.botId === 'string' ? view.wecom.botId : '',
      secret,
      connectionMode: (view.wecom.connectionMode as WecomConnectionMode | undefined) ?? 'websocket',
      pluginPackage: view.pluginPackage || DEFAULT_WECOM_PLUGIN,
      channelGateway: {
        enabled: config.channelGateway.enabled,
        wecom: config.channelGateway.wecom,
        model: config.channelGateway.model,
        server: config.channelGateway.server,
      },
      status: buildChannelGatewayStatus(config, pm),
    };
  });

  app.put('/api/channels/wecom', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const enabled = body.enabled === true;
    const botId = typeof body.botId === 'string' ? body.botId : '';
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const connectionMode: WecomConnectionMode =
      body.connectionMode === 'webhook' ? 'webhook' : 'websocket';
    const pluginPackage = typeof body.pluginPackage === 'string' ? body.pluginPackage : DEFAULT_WECOM_PLUGIN;

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
      persistWecomChannelSetup(
        configPath,
        { enabled, botId, secret, connectionMode, pluginPackage },
        {
          enabled: enableCg,
          wecom: enabled,
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

    const view = readWecomConfigView(configPath);
    return {
      ok: true,
      enabled: view.wecom.enabled === true,
      botId: typeof view.wecom.botId === 'string' ? view.wecom.botId : '',
      secret: maskSecret(view.wecom.secret),
      channelGateway: config.channelGateway,
      status: buildChannelGatewayStatus(config, pm),
    };
  });
}
