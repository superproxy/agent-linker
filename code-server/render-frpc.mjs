#!/usr/bin/env node
/**
 * Docker 聚合镜像的 frpc：登记 code-server、dev 与 noVNC 三条 HTTP。
 * 已挂载 /etc/linkagent/frpc.toml 时入口脚本不会调用本文件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function plain(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /["\r\n]/.test(text)) throw new Error(`${label} 无效`);
  return text;
}

/** customDomains 只匹配主机名。配置里可以写成 host:7080。 */
function domainHost(value, label) {
  const text = plain(value, label);
  const colon = text.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) return text.slice(0, colon);
  return text;
}

export function renderEmbeddedHttpFrpc(opts) {
  const token = plain(opts.token, 'frps token');
  const serverAddr = plain(opts.serverAddr || 'host.docker.internal', 'frps 地址');
  const serverPort = Number(opts.serverPort ?? 7000);
  if (!Number.isInteger(serverPort) || serverPort <= 0) throw new Error('frps 端口无效');
  const ideDomain = domainHost(opts.ideDomain || 'ide.localhost', 'code-server 域名');
  const devDomain = domainHost(opts.devDomain || 'dev.localhost', 'dev 域名');
  const vncDomain = domainHost(opts.vncDomain || 'vnc.localhost', 'VNC 域名');
  return `serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${token}"

[[proxies]]
name = "workspace-ide"
type = "http"
localIP = "127.0.0.1"
localPort = 8080
customDomains = ["${ideDomain}"]

[[proxies]]
name = "workspace-dev"
type = "http"
localIP = "127.0.0.1"
localPort = 5173
customDomains = ["${devDomain}"]

[[proxies]]
name = "workspace-vnc"
type = "http"
localIP = "127.0.0.1"
localPort = 6080
customDomains = ["${vncDomain}"]
`;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const token = process.env.FRPS_TOKEN ?? '';
  if (!token.trim()) process.exit(0);
  const text = renderEmbeddedHttpFrpc({
    token,
    serverAddr: process.env.FRPS_SERVER_ADDR,
    serverPort: process.env.FRPS_SERVER_PORT,
  });
  const out = process.env.FRPC_OUT || '/etc/linkagent/frpc.toml';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, { encoding: 'utf8', mode: 0o600 });
  const domains = [...text.matchAll(/customDomains = \["([^"]+)"\]/g)].map((m) => m[1]);
  console.log(`[frpc] 已写入 ${out}：${domains.join('，')}`);
}
