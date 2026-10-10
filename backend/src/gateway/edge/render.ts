import {
  FRPS_ALLOW_PORT_END,
  FRPS_ALLOW_PORT_START,
  FRPS_BIND_ADDR,
  FRPS_BIND_PORT,
  FRPS_DASHBOARD_HOST,
  FRPS_DASHBOARD_PORT,
  FRPS_VHOST_HTTP_PORT,
  NGINX_LISTEN_HOST,
  NGINX_LISTEN_PORT,
} from './assets.js';

export interface NginxRenderOptions {
  /** 带前导斜杠、无结尾斜杠，例如 /vibe-ide；code-server 实际挂在 / 时传 / */
  idePrefix: string;
  /** code-server 发布地址，供 localhost 与 ide.localhost */
  ideUpstream: string;
  /** 网关地址。{taskId}-web.localhost 整站转到这里，由页面打开该任务 IDE */
  gatewayUpstream: string;
  pidPath: string;
}

function proxyLocation(prefix: string, upstream: string): string {
  return `        location ${prefix} {
            proxy_pass ${upstream};
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_read_timeout 86400;
        }`;
}

/**
 * 本机 nginx 只监听回环。
 * localhost / ide.localhost 转到 code-server。
 * 其它 *.localhost（如 default-web.localhost、t_xxx-web.localhost）转到网关，页面按主机名打开对应任务。
 */
export function renderNginxConf(opts: NginxRenderOptions): string {
  const pid = opts.pidPath.replace(/\\/g, '/');
  const listen = `${NGINX_LISTEN_HOST}:${NGINX_LISTEN_PORT}`;
  return `daemon off;
worker_processes 1;
error_log stderr;
pid ${pid};
events { worker_connections 256; }
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }
    server {
        listen ${listen};
        server_name localhost ide.localhost;
${proxyLocation(opts.idePrefix, opts.ideUpstream)}
    }
    server {
        listen ${listen};
        server_name *.localhost;
${proxyLocation('/', opts.gatewayUpstream)}
    }
}
`;
}

export interface FrpsRenderOptions {
  token: string;
  dashboardPassword: string;
  /** 网关地址，例如 127.0.0.1:8787。设置后 Login 先问网关，节点 nt_ 也能通过。 */
  pluginAddr?: string;
}

/** frps 控制口对 NAT 客户端开放，面板只监听回环。 */
export function renderFrpsConf(opts: FrpsRenderOptions): string {
  const pluginAddr = opts.pluginAddr?.trim() ?? '';
  if (pluginAddr && /["\r\n]/.test(pluginAddr)) throw new Error('frps 插件地址无效');
  // allowPorts 等顶层键必须写在任何 [[table]] 之前，否则 TOML 会把它挂进上一张表，
  // frps 报 json: unknown field "allowPorts"。
  const plugin = pluginAddr
    ? `
[[httpPlugins]]
name = "node-tokens"
addr = "${pluginAddr}"
path = "/internal/frp/handler"
ops = ["Login"]
`
    : '';
  return `bindAddr = "${FRPS_BIND_ADDR}"
bindPort = ${FRPS_BIND_PORT}
vhostHTTPPort = ${FRPS_VHOST_HTTP_PORT}
auth.method = "token"
auth.token = "${opts.token}"
webServer.addr = "${FRPS_DASHBOARD_HOST}"
webServer.port = ${FRPS_DASHBOARD_PORT}
webServer.user = "admin"
webServer.password = "${opts.dashboardPassword}"
allowPorts = [
  { start = ${FRPS_ALLOW_PORT_START}, end = ${FRPS_ALLOW_PORT_END} }
]
${plugin}`;
}
