import type { SharedConfig } from '@linkagent/shared';
import { readGatewayTokenFile } from './auth-token.js';

/** 0.0.0.0/:: 不能作为回连地址，归一化到 127.0.0.1 */
export function loopbackHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/** 推导网关 HTTP/WS base（http://host:port） */
export function deriveGatewayBase(config: SharedConfig): string {
  const { host, port } = config.gateway.server;
  return `http://${loopbackHost(host)}:${port}`;
}

export interface ChildProcessRuntime {
  gatewayUrl: string;
  gatewayToken: string;
}

/** 比较回连目标是否为同一网关（忽略 http/ws、localhost/127.0.0.1） */
export function sameGatewayOrigin(a: string, b: string): boolean {
  const key = (raw: string): string => {
    const trimmed = raw.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
      const u = new URL(withScheme);
      const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'https' : 'http';
      let host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '::1') host = '127.0.0.1';
      const port = u.port || (proto === 'https' ? '443' : '80');
      return `${proto}://${host}:${port}`;
    } catch {
      return trimmed.replace(/\/+$/, '').toLowerCase();
    }
  };
  return key(a) === key(b);
}

/**
 * 子进程共享的回连参数：env > 配置段 > 推导缺省。
 * 回连本机网关时，token 还可回退 gateway.auth.token / token 文件；
 * 回连另一台网关时不再套用本机令牌（否则会被对端 401）。
 */
export function resolveChildRuntime(
  config: SharedConfig,
  section: { gatewayUrl?: string; gatewayToken?: string },
  env: { url?: string; token?: string } = {},
  tokenFile?: string,
): ChildProcessRuntime {
  const gatewayUrl = env.url?.trim() || section.gatewayUrl?.trim() || deriveGatewayBase(config);
  const explicitToken = env.token?.trim() || section.gatewayToken?.trim() || '';
  if (explicitToken) return { gatewayUrl, gatewayToken: explicitToken };
  const localToken = config.gateway.auth.token.trim() || readGatewayTokenFile(tokenFile);
  const gatewayToken = sameGatewayOrigin(gatewayUrl, deriveGatewayBase(config)) ? localToken : '';
  return { gatewayUrl, gatewayToken };
}
