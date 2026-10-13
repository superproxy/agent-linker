import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface CodeServerUpstream {
  host: string;
  port: number;
  /** 浏览器 / APISIX 对外路径前缀，例如 /vibe-ide */
  publicPath: string;
}

const DEFAULT: CodeServerUpstream = {
  host: '127.0.0.1',
  port: 8010,
  publicPath: '/vibe-ide',
};

function normalizePublicPath(basePath: string | undefined): string {
  const trimmed = basePath?.trim() || '/vibe-ide';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '') || '/vibe-ide';
}

/** 从 node.yaml 读取本机 code-server 回环地址与对外路径前缀。 */
export function readCodeServerUpstream(nodeYamlPath: string): CodeServerUpstream {
  if (!existsSync(nodeYamlPath)) return { ...DEFAULT };
  try {
    const doc = parseYaml(readFileSync(nodeYamlPath, 'utf8')) as {
      hostCodeServerCompose?: { host?: string; port?: number; basePath?: string };
      serveWeb?: { host?: string; port?: number; basePath?: string };
    };
    const section = doc.hostCodeServerCompose ?? doc.serveWeb;
    const hostRaw = section?.host?.trim() || DEFAULT.host;
    const host = hostRaw === '0.0.0.0' || hostRaw === '::' ? '127.0.0.1' : hostRaw;
    const port = section?.port ?? DEFAULT.port;
    const publicPath = normalizePublicPath(section?.basePath);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ...DEFAULT, publicPath };
    }
    return { host, port, publicPath };
  } catch {
    return { ...DEFAULT };
  }
}

export function codeServerHttpOrigin(upstream: CodeServerUpstream): string {
  return `http://${upstream.host}:${upstream.port}`;
}

/** 网关 / APISIX 收到的 /vibe-ide/… 转为 code-server 根路径 /…（--abs-proxy-base-path 下进程仍监听 /）。 */
export function toCodeServerProxyPath(rawUrl: string | undefined, publicPath: string): string {
  const url = rawUrl ?? '/';
  const q = url.indexOf('?');
  const pathPart = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : '';
  const prefix = normalizePublicPath(publicPath);
  let rest = pathPart;
  if (pathPart === prefix) {
    rest = '/';
  } else if (pathPart.startsWith(`${prefix}/`)) {
    rest = pathPart.slice(prefix.length) || '/';
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return `${rest}${query}`;
}
