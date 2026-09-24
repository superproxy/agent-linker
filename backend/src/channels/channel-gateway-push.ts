import type { PluginManager } from '../plugins/manager.js';
import type { ChannelGatewayRuntimeReport } from '../store/channel-gateway-runtime-report.js';
import { snapshotChannelGatewayLogs } from './channel-gateway-log-buffer.js';

export interface ChannelGatewayPushOptions {
  gatewayUrl: string;
  gatewayToken: string;
  intervalSec: number;
  exposePluginRoutes: boolean;
  listen: string;
  weixinBotCount: number;
  pluginManager: PluginManager | null;
  log: (...args: unknown[]) => void;
  errLog: (...args: unknown[]) => void;
}

function buildReport(opts: ChannelGatewayPushOptions): ChannelGatewayRuntimeReport {
  const pluginAccounts: ChannelGatewayRuntimeReport['pluginAccounts'] = [];
  if (opts.pluginManager) {
    for (const [key, st] of opts.pluginManager.accountStatus.entries()) {
      pluginAccounts.push({
        key,
        running: st.running,
        lastError: st.lastError,
      });
    }
  }
  return {
    reportedAt: Date.now(),
    service: 'channel-gateway',
    weixinBotCount: opts.weixinBotCount,
    pluginAccounts,
    http: {
      exposePluginRoutes: opts.exposePluginRoutes,
      listen: opts.listen,
    },
    logTail: snapshotChannelGatewayLogs(200),
  };
}

export async function pushRuntimeReportOnce(opts: ChannelGatewayPushOptions): Promise<boolean> {
  const base = opts.gatewayUrl.replace(/\/$/, '');
  const url = `${base}/api/channels/channel-gateway/report`;
  const report = buildReport(opts);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.gatewayToken.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      opts.errLog(`[channel-gateway] 推送运行态失败 HTTP ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    opts.errLog(`[channel-gateway] 推送运行态失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function startRuntimePushLoop(opts: ChannelGatewayPushOptions): () => void {
  const intervalMs = Math.max(5, opts.intervalSec) * 1000;
  void pushRuntimeReportOnce(opts);
  const timer = setInterval(() => void pushRuntimeReportOnce(opts), intervalMs);
  return () => clearInterval(timer);
}
