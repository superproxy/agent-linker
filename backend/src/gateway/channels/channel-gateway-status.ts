import type { SharedConfig } from '@linkagent/shared';
import type { ProcessManager } from '../../supervisor/manager.js';
import { getChannelGatewayRuntimeReport } from './runtime-report-store.js';

function publicHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export function buildChannelGatewayStatus(config: SharedConfig, pm: ProcessManager) {
  const cg = config.channelGateway;
  const expose = cg.http.exposePluginRoutes;
  const runtimeReport = getChannelGatewayRuntimeReport();
  const host = publicHost(cg.server.host);
  const port = cg.server.port;
  const base = `http://${host}:${port}`;
  const callbackUrls: string[] = [];
  if (expose) {
    if (cg.wecom) {
      callbackUrls.push(`${base}/plugins/wecom/agent`, `${base}/plugins/wecom/bot`, `${base}/wecom/agent`);
    }
    if (cg.feishu) {
      callbackUrls.push(`${base}/feishu/events`);
    }
  }
  return {
    channelGatewayEnabled: cg.enabled,
    weixinInChannels: cg.weixin,
    weixinPlugin: cg.weixinPlugin,
    channelsRunning: pm.isRunning('channels'),
    exposePluginRoutes: expose,
    callbackUrls,
    listen: expose ? `${cg.server.host}:${port}` : '',
    runtimeReport,
  };
}
