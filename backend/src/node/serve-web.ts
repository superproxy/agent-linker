import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { NodeSection } from '@linkagent/shared';

export type ServeWebConfig = NodeSection['serveWeb'];

export interface ServeWebLaunch {
  serveWeb: ServeWebConfig;
  /** 挂进 IDE 容器的目录 */
  workspaceDir: string;
  /** compose 落盘目录 */
  runtimeDir: string;
  /** 网关 frps 令牌文件。存在时把 dev 与 VNC 反向代理登记到 frps。 */
  frpsTokenFile?: string;
  /** 聚合容器内直接写这个路径，不再挂载。缺省 /etc/linkagent/frpc.toml。 */
  frpcPath?: string;
}

export interface ServeWebChild {
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

export type ServeWebSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'inherit'; windowsHide: true; shell: boolean },
) => ServeWebChild;

const CODE_CONTAINER = 'linkagent-code-serve-web';
/** code-server 默认工作目录。宿主机目录挂到这里。 */
export const IDE_CONTAINER_WORKSPACE = '/root/workspace';
/**
 * 浏览器经 9080 访问时带端口。APISIX 的 X-Forwarded-Host 不含端口，
 * code-server 会判定来源不一致并拒绝工作台 WebSocket。
 */
const IDE_TRUSTED_ORIGIN = '*.localhost:9080';
/** 与 frps vhostHTTPPort 一致。容器内 frpc 把下面两个端口登记成 HTTP 域名。 */
export const FRPS_VHOST_HTTP_PORT = 7080;
/** 聚合容器里 node 写入的位置。入口脚本看到文件后启动 frpc。 */
export const EMBEDDED_FRPC_PATH = '/etc/linkagent/frpc.toml';
export const WORKSPACE_DEV_PORT = 5173;
export const WORKSPACE_VNC_PORT = 6080;
export const WORKSPACE_DEV_HOST = 'dev.localhost';
export const WORKSPACE_VNC_HOST = 'vnc.localhost';
const NODE_MODULES_VOLUME = 'linkagent-code-node-modules';

function frpcDomain(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim() || fallback;
  const colon = text.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) return text.slice(0, colon);
  return text;
}

/** 主机模式缺省连旁边的 frps。容器里有 FRPS_SERVER_* / LINKAGENT_*_DOMAIN 时用那组地址。 */
export function renderWorkspaceFrpc(
  token: string,
  endpoint?: { serverAddr?: string; serverPort?: number; devDomain?: string; vncDomain?: string },
): string {
  const secret = token.trim();
  if (!secret || /["\r\n]/.test(secret)) throw new Error('frps token 无效');
  const serverAddr = (endpoint?.serverAddr ?? '').trim() || 'host.docker.internal';
  const serverPort = endpoint?.serverPort && endpoint.serverPort > 0 ? endpoint.serverPort : 7000;
  const devDomain = frpcDomain(endpoint?.devDomain, WORKSPACE_DEV_HOST);
  const vncDomain = frpcDomain(endpoint?.vncDomain, WORKSPACE_VNC_HOST);
  return `serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${secret}"

[[proxies]]
name = "workspace-dev"
type = "http"
localIP = "127.0.0.1"
localPort = ${WORKSPACE_DEV_PORT}
customDomains = ["${devDomain}"]

[[proxies]]
name = "workspace-vnc"
type = "http"
localIP = "127.0.0.1"
localPort = ${WORKSPACE_VNC_PORT}
customDomains = ["${vncDomain}"]
`;
}

function frpcToken(file: string | undefined): string {
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return (process.env.FRPS_TOKEN ?? '').trim() || (process.env.LINKAGENT_GATEWAY_TOKEN ?? '').trim();
}

function frpcEndpointFromEnv(): { serverAddr?: string; serverPort?: number; devDomain?: string; vncDomain?: string } {
  const port = Number(process.env.FRPS_SERVER_PORT ?? '');
  return {
    serverAddr: process.env.FRPS_SERVER_ADDR,
    serverPort: Number.isInteger(port) && port > 0 ? port : undefined,
    devDomain: process.env.LINKAGENT_DEV_DOMAIN,
    vncDomain: process.env.LINKAGENT_VNC_DOMAIN,
  };
}

function dockerVolumeHost(workspaceDir: string): string {
  return workspaceDir.replace(/\\/g, '/');
}

export function serveWebBasePath(basePath: string): string {
  const withSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withSlash.replace(/\/+$/, '') || '/vibe-ide';
}

/** node 只发布 code-server。nginx 由网关安装，反代这个回环端口。 */
export function renderIdeCompose(opts: ServeWebConfig, workspaceDir: string, frpcFile?: string): string {
  const prefix = serveWebBasePath(opts.basePath);
  const volumes = [
    `${dockerVolumeHost(workspaceDir)}:${IDE_CONTAINER_WORKSPACE}`,
    `${NODE_MODULES_VOLUME}:${IDE_CONTAINER_WORKSPACE}/node_modules`,
  ];
  if (frpcFile) volumes.push(`${dockerVolumeHost(frpcFile)}:/etc/linkagent/frpc.toml:ro`);
  const doc = {
    services: {
      'code-serve-web': {
        image: opts.image,
        container_name: CODE_CONTAINER,
        restart: 'unless-stopped',
        user: '0:0',
        shm_size: '1gb',
        extra_hosts: ['host.docker.internal:host-gateway'],
        entrypoint: ['/usr/local/bin/linkagent-entrypoint.sh'],
        command: [
          '--auth', 'none',
          '--bind-addr', '0.0.0.0:8080',
          '--abs-proxy-base-path', prefix,
          '--trusted-origins', IDE_TRUSTED_ORIGIN,
          IDE_CONTAINER_WORKSPACE,
        ],
        ports: [
          `${opts.host}:${opts.port}:8080`,
          `127.0.0.1:${WORKSPACE_DEV_PORT}:${WORKSPACE_DEV_PORT}`,
          `127.0.0.1:${WORKSPACE_VNC_PORT}:${WORKSPACE_VNC_PORT}`,
        ],
        volumes,
      },
    },
    volumes: {
      [NODE_MODULES_VOLUME]: {},
    },
  };
  return stringify(doc);
}

export function serveWebDockerArgs(composeFile: string, action: 'up' | 'down'): string[] {
  return action === 'up' ? ['compose', '-f', composeFile, 'up', '-d'] : ['compose', '-f', composeFile, 'down'];
}

/**
 * Docker 聚合镜像里 IDE / VNC / frpc 已由入口脚本拉起。
 * `LINKAGENT_NODE_SERVE_WEB=0|false|off` 时 node 不再 compose 第二个 code-server。
 */
export function nodeServeWebSuppressed(flag: string | undefined): boolean {
  const raw = (flag ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off';
}

/** node 启动时只拉起 code-server。未启用或 docker 不存在时不打断节点回连。 */
export function startNodeServeWeb(launch: ServeWebLaunch, spawnFn: ServeWebSpawn = spawn as ServeWebSpawn): { stop: () => void } {
  const { serveWeb } = launch;
  const suppressed = nodeServeWebSuppressed(process.env.LINKAGENT_NODE_SERVE_WEB);
  if (suppressed) {
    console.log('[node] LINKAGENT_NODE_SERVE_WEB 已关闭 compose，IDE 由容器入口拉起');
    const token = frpcToken(launch.frpsTokenFile);
    const out = launch.frpcPath ?? EMBEDDED_FRPC_PATH;
    if (token && existsSync(dirname(out))) {
      writeFileSync(out, renderWorkspaceFrpc(token, frpcEndpointFromEnv()), { encoding: 'utf8', mode: 0o600 });
      console.log(`[node] 已写入 ${out}，由容器入口启动 frpc`);
    }
    return { stop() {} };
  }
  if (!serveWeb.enabled) return { stop() {} };
  mkdirSync(launch.runtimeDir, { recursive: true });
  const composeFile = join(launch.runtimeDir, 'compose.yml');
  const frpcFile = join(launch.runtimeDir, 'frpc.toml');
  const token = launch.frpsTokenFile && existsSync(launch.frpsTokenFile)
    ? readFileSync(launch.frpsTokenFile, 'utf8')
    : '';
  const frpcMounted = token.trim().length > 0;
  if (frpcMounted) writeFileSync(frpcFile, renderWorkspaceFrpc(token), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(composeFile, renderIdeCompose(serveWeb, launch.workspaceDir, frpcMounted ? frpcFile : undefined), 'utf8');

  const run = (action: 'up' | 'down') => {
    try {
      const child = spawnFn('docker', serveWebDockerArgs(composeFile, action), {
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
      });
      child.on('error', (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[node] docker compose ${action} 失败：${message}`);
      });
      child.on('exit', (code) => {
        if (code && code !== 0) console.error(`[node] docker compose ${action} 退出 code=${String(code)}`);
      });
      return child;
    } catch (err) {
      console.error(`[node] docker compose ${action} 失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  console.log(`[node] 启动 IDE 容器 ${CODE_CONTAINER}，发布 ${serveWeb.host}:${serveWeb.port}`);
  run('up');
  return { stop() { run('down'); } };
}
