/** channel-gateway 进程推送到主 gateway 的运行态快照（内存，单实例） */

export interface ChannelGatewayPluginAccountReport {
  key: string;
  running: boolean;
  lastError: string | null;
}

export interface ChannelGatewayRuntimeReport {
  reportedAt: number;
  service: 'channel-gateway';
  weixinBotCount: number;
  pluginAccounts: ChannelGatewayPluginAccountReport[];
  http: {
    exposePluginRoutes: boolean;
    listen: string;
  };
  /** channels 进程推送的最近日志行（内存环，便于远程调试企微/插件） */
  logTail?: string[];
}

let lastReport: ChannelGatewayRuntimeReport | null = null;

export function setChannelGatewayRuntimeReport(report: ChannelGatewayRuntimeReport): void {
  lastReport = report;
}

export function getChannelGatewayRuntimeReport(): ChannelGatewayRuntimeReport | null {
  return lastReport;
}
