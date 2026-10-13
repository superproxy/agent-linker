import http from 'node:http';
import net from 'node:net';
import { taskPublicPath, taskSubdomainUsesPathRewrite } from '@linkagent/shared';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
]);

/** frps 把原始路径原样送到本机。适配器听这些口，应用仍听 5173 / 8080 / 6080。 */
export const SAAS_DEV_LISTEN = 15173;
export const SAAS_IDE_LISTEN = 18080;
export const SAAS_VNC_LISTEN = 16080;

export type SaasPathKind = 'dev' | 'code' | 'vnc';

/**
 * frps 只按 Host + 最长 location 选代理，不剥路径。
 * dev：`/-web` 仅路由区分；15173 请求 **rewrite 去掉** 前缀，upstream Vite base `/`；HTML/Location 再补回前缀。
 * code / vnc 去掉任务前缀，本机进程仍挂在 `/`。
 */
export function rewriteSaasLocalPath(kind: SaasPathKind, taskId: string, url: string): string {
  if (!taskSubdomainUsesPathRewrite()) return url;
  const queryAt = url.indexOf('?');
  const path = queryAt >= 0 ? url.slice(0, queryAt) : url;
  const query = queryAt >= 0 ? url.slice(queryAt) : '';
  if (kind === 'dev') {
    const web = taskPublicPath(taskId, 'web');
    if (!web) return url;
    const toRoot = (rest: string): string => {
      const suffix = rest === '' || rest === '/' ? '/' : rest.startsWith('/') ? rest : `/${rest}`;
      return `${suffix}${query}`;
    };
    if (path === web || path === `${web}/`) return toRoot('');
    if (path.startsWith(`${web}/`)) return toRoot(path.slice(web.length));
    return url;
  }
  const prefix = taskPublicPath(taskId, kind === 'code' ? 'code' : 'vnc');
  if (!prefix) return url;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return url;
  const rest = path.slice(prefix.length) || '/';
  return `${rest.startsWith('/') ? rest : `/${rest}`}${query}`;
}

/**
 * 公网 HTTPS 走 HTTP/2。分块且不带 Content-Length 的大文件（code-server 的 workbench.js）
 * 会被前面的负载均衡拆连接。这里去掉逐跳头，按实际字节数写 Content-Length。
 */
/**
 * code-server 对无斜杠入口回 `Location: ./?folder=...`。
 * 浏览器会把这个相对地址解析到站点根，公网就变成 APISIX 的 404。
 * 按「这个路径是目录」来解析，并给绝对路径补上 `/<taskId>-code|vnc`。
 */
/** dev：Vite 回根路径 Location，浏览器需带 `/<taskId>-web` 前缀。 */
export function rewriteDevPublicLocation(taskId: string, location: string): string {
  if (!taskSubdomainUsesPathRewrite()) return location;
  if (/^https?:\/\//i.test(location)) return location;
  const web = taskPublicPath(taskId, 'web');
  if (!web) return location;
  if (location.startsWith('/') && !location.startsWith(web)) return `${web}${location}`;
  return location;
}

/** dev HTML：Vite 输出 `href="/…"`，补公网 `/-web` 前缀（避免 `/@vite/client` 打到 9080 根）。 */
export function rewriteDevHtmlForPublicPath(taskId: string, html: string): string {
  if (!taskSubdomainUsesPathRewrite()) return html;
  const web = taskPublicPath(taskId, 'web');
  if (!web) return html;
  const webTail = web.startsWith('/') ? web.slice(1) : web;
  return html.replace(/(\s(?:href|src)=["'])\/([^"'#?]*)/g, (full, attr, rest: string) => {
    if (rest === '' || rest.startsWith(`${webTail}/`) || rest === webTail) return full;
    return `${attr}${web}/${rest}`;
  });
}

export function rewriteSaasRedirect(kind: 'code' | 'vnc', taskId: string, requestUrl: string, location: string): string {
  if (!taskSubdomainUsesPathRewrite()) return location;
  if (/^https?:\/\//i.test(location)) return location;
  const prefix = taskPublicPath(taskId, kind);
  if (!prefix) return location;
  if (location.startsWith('/')) return location.startsWith(prefix) ? location : `${prefix}${location}`;
  const queryAt = requestUrl.indexOf('?');
  const path = queryAt >= 0 ? requestUrl.slice(0, queryAt) : requestUrl;
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dir = path.endsWith('/') || last.includes('.') ? path.slice(0, path.lastIndexOf('/') + 1) : `${path}/`;
  const resolved = new URL(location, `http://local${dir.startsWith('/') ? dir : `/${dir}`}`);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function adapterResponseHeaders(headers: http.IncomingHttpHeaders, bodyLength: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value == null) continue;
    out[key] = value;
  }
  out['content-length'] = String(bodyLength);
  return out;
}

function readUpstreamBody(upstream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
    upstream.on('end', () => resolve(Buffer.concat(chunks)));
    upstream.on('error', reject);
  });
}

type TargetPort = number | (() => number);

function resolveTargetPort(targetPort: TargetPort): number {
  return typeof targetPort === 'function' ? targetPort() : targetPort;
}

/** 公网入口 `/<taskId>-{web|code|vnc}` 无尾斜杠时 301 到带 `/`。 */
export function saasPublicEntryTrailingSlashRedirect(
  kind: 'dev' | 'code' | 'vnc',
  taskId: string,
  url: string,
): string | null {
  if (!taskSubdomainUsesPathRewrite()) return null;
  const queryAt = url.indexOf('?');
  const path = queryAt >= 0 ? url.slice(0, queryAt) : url;
  const query = queryAt >= 0 ? url.slice(queryAt) : '';
  const routeType = kind === 'dev' ? 'web' : kind;
  const entry = taskPublicPath(taskId, routeType);
  if (!entry) return null;
  if (path === entry) return `${entry}/${query}`;
  return null;
}

/** @deprecated 使用 {@link saasPublicEntryTrailingSlashRedirect} */
export function devPublicWebTrailingSlashRedirect(taskId: string, url: string): string | null {
  return saasPublicEntryTrailingSlashRedirect('dev', taskId, url);
}

function forward(kind: SaasPathKind, taskId: () => string, targetPort: TargetPort, listenPort: number): http.Server {
  const server = http.createServer((req, res) => {
    const rawUrl = req.url || '/';
    const slashRedirect = saasPublicEntryTrailingSlashRedirect(kind, taskId(), rawUrl);
    if (slashRedirect) {
      res.writeHead(301, { Location: slashRedirect });
      res.end();
      return;
    }
    const port = resolveTargetPort(targetPort);
    const path = rewriteSaasLocalPath(kind, taskId(), rawUrl);
    const headers = { ...req.headers };
    /** 上游 Vite 只监听 127.0.0.1；保留 ide.localhost 会触发 Host 校验（Vite 5 无 CLI allowedHosts）。 */
    headers.host = `127.0.0.1:${port}`;
    const upstream = http.request(
      { host: '127.0.0.1', port, path, method: req.method, headers },
      (up) => {
        readUpstreamBody(up)
          .then((body) => {
            if (res.writableEnded) return;
            const upstreamHeaders = { ...up.headers };
            const loc = upstreamHeaders.location;
            if (typeof loc === 'string') {
              if (kind === 'dev') upstreamHeaders.location = rewriteDevPublicLocation(taskId(), loc);
              else if (kind === 'code' || kind === 'vnc') {
                upstreamHeaders.location = rewriteSaasRedirect(kind, taskId(), req.url || '/', loc);
              }
            }
            let out = body;
            if (kind === 'dev') {
              const ct = upstreamHeaders['content-type'];
              const ctStr = Array.isArray(ct) ? ct[0] : ct;
              if (typeof ctStr === 'string' && ctStr.toLowerCase().includes('text/html')) {
                out = Buffer.from(rewriteDevHtmlForPublicPath(taskId(), body.toString('utf8')), 'utf8');
              }
            }
            res.writeHead(up.statusCode || 502, adapterResponseHeaders(upstreamHeaders, out.length));
            res.end(out);
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(502);
            res.end('bad gateway');
          });
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('bad gateway');
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const port = resolveTargetPort(targetPort);
    const path = rewriteSaasLocalPath(kind, taskId(), req.url || '/');
    const conn = net.connect(port, '127.0.0.1', () => {
      const headers = { ...req.headers };
      headers.host = `127.0.0.1:${port}`;
      let raw = `${req.method} ${path} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        if (value == null) continue;
        raw += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
      }
      raw += '\r\n';
      conn.write(raw);
      if (head.length) conn.write(head);
      socket.pipe(conn);
      conn.pipe(socket);
    });
    conn.on('error', () => socket.destroy());
    socket.on('error', () => conn.destroy());
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') return;
    console.error(`[node] 路径适配器 127.0.0.1:${listenPort} 监听失败：${err.message}`);
  });
  server.listen(listenPort, '127.0.0.1');
  return server;
}

export interface SaasAdapterPorts {
  dev: number;
  code: number;
  vnc: number;
}

const DEFAULT_ADAPTER_PORTS: SaasAdapterPorts = {
  dev: 5173,
  code: 8080,
  vnc: 6080,
};

let currentTaskId = '';
let devTargetPort = DEFAULT_ADAPTER_PORTS.dev;
let servers: http.Server[] | null = null;

/** Vite 实际监听口（可动态）；frpc 仍指向 {@link SAAS_DEV_LISTEN}。 */
export function setSaasDevTargetPort(port: number): void {
  if (Number.isInteger(port) && port > 0 && port <= 65535) devTargetPort = port;
}

export function getSaasDevTargetPort(): number {
  return devTargetPort;
}

/** 同一进程里换任务只改前缀，不重新占端口。单机 enhance 时 code 口常为宿主机 8010。 */
export function ensureSaasLocalAdapter(taskId: string, ports: SaasAdapterPorts = DEFAULT_ADAPTER_PORTS): void {
  currentTaskId = taskId;
  if (ports.dev !== DEFAULT_ADAPTER_PORTS.dev) devTargetPort = ports.dev;
  if (servers) return;
  const task = () => currentTaskId;
  servers = [
    forward('dev', task, () => devTargetPort, SAAS_DEV_LISTEN),
    forward('code', task, ports.code, SAAS_IDE_LISTEN),
    forward('vnc', task, ports.vnc, SAAS_VNC_LISTEN),
  ];
}

/** 测试或进程退出前释放 15173/18080/16080 监听。 */
export function closeSaasLocalAdapters(): void {
  for (const server of servers ?? []) {
    server.close();
  }
  servers = null;
  currentTaskId = '';
}
