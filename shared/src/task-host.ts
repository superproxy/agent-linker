/** 浏览器入口缺省主机。实际值由 gateway.yaml 的 edge.publicHost 加载。 */
export const TASK_PUBLIC_HOST = 'ide.localhost';
export const TASK_PUBLIC_PORT = 8088;

export interface EdgePublicConfig {
  publicHost: string;
  publicPort: number;
}

/** 读 edge 配置。`publicHost` 可以写成 `host:443`，这时用这个端口，https 不带端口号。 */
export function resolveEdgePublic(input?: { publicHost?: string; publicPort?: number }): EdgePublicConfig {
  let host = (input?.publicHost ?? TASK_PUBLIC_HOST).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let port = input?.publicPort ?? TASK_PUBLIC_PORT;
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    port = Number(host.slice(colon + 1));
    host = host.slice(0, colon);
  }
  if (!host || /[\s"/]/.test(host)) host = TASK_PUBLIC_HOST;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) port = TASK_PUBLIC_PORT;
  return { publicHost: host, publicPort: port };
}

export const TASK_ROUTE_TYPES = ['web', 'code', 'vnc'] as const;
export type TaskRouteType = (typeof TASK_ROUTE_TYPES)[number];

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = '-';

function adaptBias(delta: number, numPoints: number, firstTime: boolean): number {
  let next = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  next += Math.floor(next / numPoints);
  let k = 0;
  while (next > Math.floor(((BASE - TMIN) * TMAX) / 2)) {
    next = Math.floor(next / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * next) / (next + SKEW));
}

function decodeDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 22;
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97;
  return BASE;
}

/** 解码一个 `xn--` 标签。失败时保留原文。 */
function decodePunycode(input: string): string {
  const basicEnd = input.lastIndexOf(DELIMITER);
  const output = basicEnd > 0 ? [...input.slice(0, basicEnd)] : [];
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let index = basicEnd < 0 ? 0 : basicEnd + 1;
  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return input;
      const digit = decodeDigit(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) return input;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adaptBias(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    i %= length;
    output.splice(i, 0, String.fromCodePoint(n));
    i += 1;
  }
  return output.join('');
}

/** 把主机名里的 punycode 标签还原成任务名称可读的形式。 */
export function decodeHostname(hostname: string): string {
  return hostname
    .split('.')
    .map((label) => (label.startsWith('xn--') ? decodePunycode(label.slice(4)) : label))
    .join('.');
}

/** 任务名称里不能出现点号，否则会拆成多级域名。 */
export function taskNameSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `{名称}-{任务号}`。名称过长时截断，空名称只留任务号。 */
export function taskHostStem(name: string, taskId: string): string {
  const id = taskId.trim().toLowerCase().replace(/_/g, '-');
  if (!id) return '';
  let slug = taskNameSlug(name);
  if (!slug || slug === id) return id;
  const chars = [...slug];
  if (chars.length > 24) slug = chars.slice(0, 24).join('').replace(/-+$/g, '');
  return slug ? `${slug}-${id}` : id;
}

export function taskPublicHost(name: string, taskId: string, kind: 'web' | 'ide' | 'dev' | 'vnc'): string {
  const stem = taskHostStem(name, taskId);
  if (!stem) return '';
  return `${stem}-${kind}.localhost`;
}

/** 正式入口上的路径，例如 `/t_41db7238-code`。 */
export function taskPublicPath(taskId: string, type: TaskRouteType): string {
  const id = taskId.trim();
  if (!id) return '';
  return `/${id}-${type}`;
}

/** 从 `/<taskId>-web|code|vnc` 取出任务号。后面还可以带 `/vnc.html` 这类子路径。 */
export function taskIdFromPublicPath(pathname: string): string | null {
  const path = pathname.split('?')[0] ?? '';
  const matched = /^\/(t[_-][0-9a-f]{8}|default)-(web|code|vnc)(?:\/|$)/i.exec(path);
  const id = matched?.[1];
  return id ? id.toLowerCase() : null;
}

/**
 * 从 `名称-任务号-web.localhost` 取出任务号。
 * 任务号是 `default` 或 `t_` 加 8 位十六进制，连字符写法也认。
 */
export function taskIdFromHostname(hostname: string): string | null {
  const host = decodeHostname(hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, ''));
  if (!host.endsWith('.localhost')) return null;
  const label = host.slice(0, -'.localhost'.length);
  if (!label.endsWith('-web') || label.includes('.')) return null;
  const stem = label.slice(0, -'-web'.length);
  const matched = /(?:^|-)(t[_-][0-9a-f]{8}|default)$/.exec(stem);
  const id = matched?.[1];
  if (!id) return null;
  return id;
}
