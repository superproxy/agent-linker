/** 公网主机走 SaaS：frps 按路径区分。`*.localhost` 是本机模式。 */
export function isSaasPublicHost(host: string | undefined): boolean {
  const text = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!text || text === 'localhost' || text.endsWith('.localhost')) return false;
  return true;
}

/**
 * frps HTTP 代理是否用「浏览器入口 Host + locations 路径前缀」选路由（与 SaaS 相同）。
 * 为 true 时 APISIX 不改 Host/路径；node frpc 登记 `/<taskId>-web|code|vnc`，由本地适配器剥前缀。
 * `legacy` / `tcp` 见 {@link resolveLinkagentFrpcMode}。
 */
export function useFrpTaskPathRouting(host: string | undefined): boolean {
  const text = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!text || text === 'localhost') return false;
  if (text === 'dev.localhost' || text === 'vnc.localhost') return false;
  return true;
}

/** frpc + APISIX 协同方式（gateway 与 worker 须一致）。 */
export type LinkagentFrpcMode = 'path' | 'legacy' | 'tcp';

const FRPC_MODE_DEFAULT: LinkagentFrpcMode = 'path';

function frpTcpPortAllowed(n: number): boolean {
  return Number.isInteger(n) && n >= 10000 && n <= 50000;
}

/**
 * 统一路由模式：`LINKAGENT_FRPC_MODE=path|legacy|tcp`。
 * 兼容旧变量：`LINKAGENT_FRPC_TCP_MODE=1` → tcp，`LINKAGENT_FRPC_LEGACY_HOSTS=1` → legacy（`MODE` 优先）。
 */
export function resolveLinkagentFrpcMode(): LinkagentFrpcMode {
  const raw = (process.env.LINKAGENT_FRPC_MODE ?? '').trim().toLowerCase();
  if (raw === 'path' || raw === 'legacy' || raw === 'tcp') return raw;
  if (raw) {
    if (raw === '1' || raw === 'true' || raw === 'on') return 'tcp';
    if (raw === '0' || raw === 'false' || raw === 'off') return FRPC_MODE_DEFAULT;
  }
  if ((process.env.LINKAGENT_FRPC_TCP_MODE ?? '').trim() === '1') return 'tcp';
  if ((process.env.LINKAGENT_FRPC_LEGACY_HOSTS ?? '').trim() === '1') return 'legacy';
  return FRPC_MODE_DEFAULT;
}

/** frpc 用 TCP 登记固定 remotePort（APISIX 剥路径后直连该端口，不经 frps HTTP 7080）。 */
export function frpcUsesTcpProxies(): boolean {
  return resolveLinkagentFrpcMode() === 'tcp';
}

function frpcLegacyThreeHosts(): boolean {
  return resolveLinkagentFrpcMode() === 'legacy';
}

/** frps `allowPorts` 段内的工作区 TCP 远端口（本机 APISIX upstream 对齐）。 */
export function workspaceFrpTcpRemotePorts(): { dev: number; code: number; vnc: number } {
  const defaults = { dev: 20001, code: 20002, vnc: 20003 };
  const list = (process.env.LINKAGENT_FRPC_TCP_PORTS ?? '').trim();
  if (list) {
    const parts = list.split(/[,;\s]+/).map((p) => Number(p.trim()));
    if (parts.length >= 3) {
      const dev = parts[0];
      const code = parts[1];
      const vnc = parts[2];
      return {
        dev: dev !== undefined && frpTcpPortAllowed(dev) ? dev : defaults.dev,
        code: code !== undefined && frpTcpPortAllowed(code) ? code : defaults.code,
        vnc: vnc !== undefined && frpTcpPortAllowed(vnc) ? vnc : defaults.vnc,
      };
    }
  }
  const dev = Number(process.env.LINKAGENT_FRPC_TCP_DEV_PORT ?? String(defaults.dev));
  const code = Number(process.env.LINKAGENT_FRPC_TCP_CODE_PORT ?? String(defaults.code));
  const vnc = Number(process.env.LINKAGENT_FRPC_TCP_VNC_PORT ?? String(defaults.vnc));
  return {
    dev: frpTcpPortAllowed(dev) ? dev : defaults.dev,
    code: frpTcpPortAllowed(code) ? code : defaults.code,
    vnc: frpTcpPortAllowed(vnc) ? vnc : defaults.vnc,
  };
}

/**
 * frpc 是否在 frps 上登记 `/<taskId>-web|code|vnc`（切任务需改 toml）。
 * `legacy` / `tcp` 时为 false：固定隧道，由 APISIX 剥路径。
 */
export function frpcUsesTaskPathLocations(host: string | undefined): boolean {
  const mode = resolveLinkagentFrpcMode();
  if (mode === 'legacy' || mode === 'tcp') return false;
  if (useTaskSubdomainRouting(host)) return false;
  return useFrpTaskPathRouting(host);
}

/** APISIX 上游走 frps TCP 隧道口，而非 vhostHTTP 7080。 */
export function apisixUpstreamUsesFrpTcp(_host: string | undefined): boolean {
  return frpcUsesTcpProxies();
}

/** APISIX 进 frps 前剥任务路径并改 Host（子域模式不剥；legacy/tcp 与 path locations 互斥）。 */
export function apisixStripsTaskPathBeforeFrps(host: string | undefined): boolean {
  if (useTaskSubdomainRouting(host)) return false;
  return useFrpTaskPathRouting(host) && !frpcUsesTaskPathLocations(host);
}

/** 浏览器入口缺省主机。实际值由 gateway.yaml 的 edge.publicHost 加载。 */
export const TASK_PUBLIC_HOST = 'ide.localhost';
export const TASK_PUBLIC_PORT = 9080;

/** 浏览器 URL：`path` = `/<taskId>-web`；`host` = `{stem}-web.<apex>`（需 DNS `*.<apex>`）。 */
export type LinkagentTaskRouting = 'path' | 'host';

export interface EdgePublicConfig {
  publicHost: string;
  publicPort: number;
  taskRouting: LinkagentTaskRouting;
}

/** `LINKAGENT_TASK_ROUTING=path|host`；`host`/`subdomain`/`sub` 均视为 host（yaml 见 {@link resolveEdgePublic}）。 */
export function resolveLinkagentTaskRouting(): LinkagentTaskRouting {
  const raw = (process.env.LINKAGENT_TASK_ROUTING ?? '').trim().toLowerCase();
  if (raw === 'host' || raw === 'subdomain' || raw === 'sub') return 'host';
  if (raw === 'path') return 'path';
  return 'path';
}

/** 公网 apex 下用子域区分任务（与 {@link useFrpTaskPathRouting} 叠加）。 */
export function useTaskSubdomainRouting(host: string | undefined): boolean {
  if (resolveLinkagentTaskRouting() !== 'host') return false;
  return useFrpTaskPathRouting(host);
}

/** 读 edge 配置。`publicHost` 可以写成 `host:443`，这时用这个端口，https 不带端口号。 */
export function resolveEdgePublic(input?: {
  publicHost?: string;
  publicPort?: number;
  taskRouting?: LinkagentTaskRouting;
}): EdgePublicConfig {
  let host = (input?.publicHost ?? TASK_PUBLIC_HOST).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let port = input?.publicPort ?? TASK_PUBLIC_PORT;
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    port = Number(host.slice(colon + 1));
    host = host.slice(0, colon);
  }
  if (!host || /[\s"/]/.test(host)) host = TASK_PUBLIC_HOST;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) port = TASK_PUBLIC_PORT;
  let taskRouting: LinkagentTaskRouting = 'path';
  const rawEnv = (process.env.LINKAGENT_TASK_ROUTING ?? '').trim().toLowerCase();
  if (rawEnv === 'host' || rawEnv === 'subdomain' || rawEnv === 'sub') taskRouting = 'host';
  else if (rawEnv === 'path') taskRouting = 'path';
  else if (input?.taskRouting === 'host' || input?.taskRouting === 'path') taskRouting = input.taskRouting;
  return { publicHost: host, publicPort: port, taskRouting };
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
  const route = kind === 'ide' ? 'code' : kind === 'dev' ? 'web' : kind;
  return taskSubdomainHost(name, taskId, route, TASK_PUBLIC_HOST);
}

/** 任务子域 FQDN：`{stem}-web.<apex>`（本机 `default-web.ide.localhost`，SaaS `…-web.hubide.ljyd.cn`）。code → `-ide`。 */
export function taskSubdomainHost(
  taskName: string,
  taskId: string,
  route: 'web' | 'code' | 'vnc',
  apexHost: string,
): string {
  const stem = taskHostStem(taskName, taskId);
  if (!stem) return '';
  const kind = route === 'code' ? 'ide' : route === 'web' ? 'web' : 'vnc';
  const apex = apexHost.trim().toLowerCase().replace(/\.$/, '');
  if (!apex || apex === 'localhost') return '';
  return `${stem}-${kind}.${apex}`;
}

export function taskSubdomainUsesPathRewrite(): boolean {
  return resolveLinkagentTaskRouting() !== 'host';
}

/** 正式入口上的路径，例如 `/t_41db7238-code`。 */
export function taskPublicPath(taskId: string, type: TaskRouteType): string {
  const id = taskId.trim();
  if (!id) return '';
  return `/${id}-${type}`;
}

/** Dev 短链前缀（无 `-web`），与 {@link taskViteBasePath} 对应。 */
export function taskSaasDevShortPath(taskId: string): string {
  const id = taskId.trim();
  if (!id) return '';
  return `/${id}`;
}

/** @deprecated 路径模式下不在宿主机 dev 使用；仅聚合容器内 legacy 脚本可能仍读 `LINKAGENT_VITE_BASE`。公网入口用 `taskPublicPath(id, 'web')`。 */
export function taskViteBasePath(taskId: string): string {
  const short = taskSaasDevShortPath(taskId);
  if (!short) return '/';
  return `${short}/`;
}

/** Vite `base`，与公网 dev 入口 `taskPublicPath(id, 'web')` 一致，避免 HTML 里 `/@vite/client` 落到站点根。 */
export function taskViteWebBasePath(taskId: string): string {
  const web = taskPublicPath(taskId, 'web');
  if (!web) return '/';
  return `${web}/`;
}

/** frps `workspace-dev` 登记的 locations（仅 `/<taskId>-web`；15173 剥前缀 upstream，Vite base `/`）。 */
export function taskSaasDevFrpcLocations(taskId: string): string[] {
  const web = taskPublicPath(taskId, 'web');
  if (!web) return [];
  return [web];
}

/** code-server `--abs-proxy-base-path`，与 frpc `taskPublicPath(id, 'code')` 一致。 */
export function taskSaasCodeProxyBasePath(taskId: string): string {
  return taskPublicPath(taskId, 'code') || '/vibe-ide';
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
  const parts = host.split('.');
  if (parts.length < 2 || parts[parts.length - 1] !== 'localhost') return null;
  const leaf = parts[0] ?? '';
  if (!leaf.endsWith('-web')) return null;
  const stem = leaf.slice(0, -'-web'.length);
  const matched = /(?:^|-)(t[_-][0-9a-f]{8}|default)$/.exec(stem);
  const id = matched?.[1];
  if (!id) return null;
  return id;
}
