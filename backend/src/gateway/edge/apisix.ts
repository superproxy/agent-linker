import { domainToASCII } from 'node:url';
import { TASK_PUBLIC_HOST, taskPublicHost, taskPublicPath, type TaskRouteType } from '@linkagent/shared';
import { NGINX_LISTEN_HOST, NGINX_LISTEN_PORT } from './assets.js';

/** 带管理 API 的 APISIX。任务域名用 Admin API 创建和开关，不重载配置。 */
export const APISIX_IMAGE = 'apache/apisix:3.11.0-debian';
export const ETCD_IMAGE = 'quay.io/coreos/etcd:v3.5.16';
export const APISIX_ADMIN_PORT = 9180;
export const APISIX_PROJECT = 'linkagent-edge';

export interface ApisixRouteSpec {
  id: string;
  host: string;
  /** 缺省匹配全部路径。任务路由写成 `/<taskId>-web*` 这种前缀。 */
  uri?: string;
  /** 形如 http://127.0.0.1:8787，容器内回环会改写成 host.docker.internal */
  upstream: string;
  enabled: boolean;
  /** [正则, 替换]。code / vnc 去掉任务前缀后再交给上游。 */
  rewrite?: [string, string];
}

export { TASK_PUBLIC_HOST };

/** APISIX 前缀匹配，例如 `/t_41db7238-code*`。 */
export function taskRouteUri(taskId: string, type: TaskRouteType): string {
  const path = taskPublicPath(taskId, type);
  return path ? `${path}*` : '/*';
}

export function taskRouteId(taskId: string): string {
  const safe = taskId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return `task-${safe}`;
}

function taskHostForProxy(name: string, taskId: string, kind: 'web' | 'ide' | 'dev' | 'vnc'): string {
  const host = taskPublicHost(name, taskId, kind);
  if (!host) return '';
  if (!/[^\u0000-\u007f]/.test(host)) return host;
  return domainToASCII(host) || host;
}

/** Web 管理端，例如 test-t_41db7238-web.localhost。中文名称写成 punycode。 */
export function taskRouteHost(name: string, taskId: string): string {
  return taskHostForProxy(name, taskId, 'web');
}

/** code-server 按任务号标识，例如 default-ide.localhost。 */
export function taskCodeRouteId(taskId: string): string {
  return `task-code-${taskRouteId(taskId).slice('task-'.length)}`;
}

/** code-server，例如 test-t_41db7238-ide.localhost。 */
export function taskCodeServerHost(name: string, taskId: string): string {
  return taskHostForProxy(name, taskId, 'ide');
}

export function taskDevRouteId(taskId: string): string {
  return `task-dev-${taskRouteId(taskId).slice('task-'.length)}`;
}

/** npm run dev，例如 test-t_41db7238-dev.localhost。 */
export function taskDevHost(name: string, taskId: string): string {
  return taskHostForProxy(name, taskId, 'dev');
}

export function taskVncRouteId(taskId: string): string {
  return `task-vnc-${taskRouteId(taskId).slice('task-'.length)}`;
}

/** noVNC，例如 test-t_41db7238-vnc.localhost。 */
export function taskVncHost(name: string, taskId: string): string {
  return taskHostForProxy(name, taskId, 'vnc');
}

/** 容器访问宿主机服务时，127.0.0.1 指的是容器自己。 */
export function apisixUpstreamNode(upstream: string): string {
  const url = new URL(upstream);
  const host = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    ? 'host.docker.internal'
    : url.hostname;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${host}:${port}`;
}

export function renderApisixRoute(spec: ApisixRouteSpec): Record<string, unknown> {
  return {
    name: spec.id,
    uri: spec.uri ?? '/*',
    host: spec.host,
    enable_websocket: true,
    status: spec.enabled ? 1 : 0,
    ...(spec.rewrite ? { plugins: { 'proxy-rewrite': { regex_uri: spec.rewrite } } } : {}),
    upstream: {
      type: 'roundrobin',
      scheme: 'http',
      pass_host: 'pass',
      timeout: { connect: 6, send: 86400, read: 86400 },
      nodes: { [apisixUpstreamNode(spec.upstream)]: 1 },
    },
  };
}

export function renderApisixConfig(adminKey: string): string {
  return `apisix:
  node_listen: 9080
deployment:
  role: traditional
  role_traditional:
    config_provider: etcd
  admin:
    admin_listen:
      ip: 0.0.0.0
      port: ${APISIX_ADMIN_PORT}
    allow_admin:
      - 0.0.0.0/0
    admin_key:
      - name: admin
        key: ${adminKey}
        role: admin
  etcd:
    host:
      - http://etcd:2379
    prefix: /apisix
`;
}

export function renderApisixCompose(): string {
  return `services:
  etcd:
    image: ${ETCD_IMAGE}
    command:
      - etcd
      - --name=etcd
      - --data-dir=/etcd-data
      - --listen-client-urls=http://0.0.0.0:2379
      - --advertise-client-urls=http://etcd:2379
  apisix:
    image: ${APISIX_IMAGE}
    depends_on:
      - etcd
    extra_hosts:
      - host.docker.internal:host-gateway
    ports:
      - ${NGINX_LISTEN_HOST}:${NGINX_LISTEN_PORT}:9080
      - ${NGINX_LISTEN_HOST}:${APISIX_ADMIN_PORT}:${APISIX_ADMIN_PORT}
    volumes:
      - ./apisix-config.yaml:/usr/local/apisix/conf/config.yaml:ro
`;
}

export function apisixComposeArgs(composeFile: string, action: 'up' | 'down'): string[] {
  const base = ['compose', '-p', APISIX_PROJECT, '-f', composeFile];
  return action === 'up' ? [...base, 'up', '-d'] : [...base, 'down'];
}

export class ApisixAdmin {
  constructor(
    private readonly adminUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upsert(spec: ApisixRouteSpec): Promise<void> {
    const res = await this.fetchImpl(`${this.adminUrl}/apisix/admin/routes/${encodeURIComponent(spec.id)}`, {
      method: 'PUT',
      headers: { 'X-API-KEY': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(renderApisixRoute(spec)),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`APISIX 写入路由 ${spec.id} 失败 ${res.status} ${text}`);
    }
  }

  async remove(id: string): Promise<void> {
    const res = await this.fetchImpl(`${this.adminUrl}/apisix/admin/routes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': this.apiKey },
    });
    if (res.status === 404) return;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`APISIX 删除路由 ${id} 失败 ${res.status} ${text}`);
    }
  }
}
