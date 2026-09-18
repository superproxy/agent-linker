/** 与「网关连接」无关：进程管理打当前页面所在网关（web 与 gateway 同端口） */
export const DEFAULT_BASE = 'http://127.0.0.1:8787';

export function isLoopbackHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function isLoopbackBase(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** localhost / 127.0.0.1 / ::1 在浏览器里是不同源，但对后台是同一台机 */
export function isLoopbackAliasPair(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol) return false;
    if ((ua.port || defaultPort(ua.protocol)) !== (ub.port || defaultPort(ub.protocol))) return false;
    return isLoopbackHostname(ua.hostname) && isLoopbackHostname(ub.hostname);
  } catch {
    return false;
  }
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/** 候选地址若只是回环别名不同，改用页面 origin，避免 localhost↔127.0.0.1 跨域 */
export function alignToPageOrigin(origin: string, candidate: string): string {
  const o = stripSlash(origin);
  const c = stripSlash(candidate);
  if (!c) return o || DEFAULT_BASE;
  if (o && (o === c || isLoopbackAliasPair(o, c))) return o;
  return c;
}

/** 进程管理 API 基址 = 打开后台的那台机器（本机 127 / 远程即该部署地址） */
export function processApiBase(origin: string): string {
  return stripSlash(origin) || DEFAULT_BASE;
}

/**
 * 管理后台其它 API 的缺省网关地址：
 * 未保存过则用当前页面 origin（web 与 gateway 同端口）；
 * localhost 与 127.0.0.1 对齐到页面主机；本机 127 不带到远程部署页。
 */
export function initialGatewayBase(origin: string, saved: string | null): string {
  const o = stripSlash(origin);
  const s = (saved ?? '').trim();
  if (!s) return o || DEFAULT_BASE;
  const aligned = alignToPageOrigin(o || DEFAULT_BASE, s);
  if (o && isLoopbackBase(aligned) && !isLoopbackBase(o)) return o;
  return aligned;
}
