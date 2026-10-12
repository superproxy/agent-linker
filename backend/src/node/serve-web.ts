import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { isSaasPublicHost, type NodeSection } from '@linkagent/shared';
import { dockerExecutable } from '../gateway/edge/runtime.js';
import { ensureSaasLocalAdapter, SAAS_DEV_LISTEN, SAAS_IDE_LISTEN, SAAS_VNC_LISTEN } from './saas-path.js';

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
export const WORKSPACE_IDE_PORT = 8080;
export const WORKSPACE_DEV_PORT = 5173;
export const WORKSPACE_VNC_PORT = 6080;
export const WORKSPACE_IDE_HOST = 'ide.localhost';
export const WORKSPACE_DEV_HOST = 'dev.localhost';
export const WORKSPACE_VNC_HOST = 'vnc.localhost';
const NODE_MODULES_VOLUME = 'linkagent-code-node-modules';

function frpcDomain(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim() || fallback;
  const colon = text.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) return text.slice(0, colon);
  return text;
}

function frpcProxy(name: string, port: number, domain: string, locations?: string[]): string {
  const lines = [
    '[[proxies]]',
    `name = "${name}"`,
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${port}`,
    `customDomains = ["${domain}"]`,
  ];
  if (locations && locations.length > 0) {
    lines.push(`locations = [${locations.map((item) => `"${item}"`).join(', ')}]`);
  }
  return lines.join('\n');
}

/**
 * 本机：三个 localhost Host，APISIX 改写 Host。
 * SaaS：同一个公网域名，用路径区分当前任务。路径随任务切换。
 */
export function renderWorkspaceFrpc(
  token: string,
  endpoint?: {
    serverAddr?: string;
    serverPort?: number;
    ideDomain?: string;
    devDomain?: string;
    vncDomain?: string;
    publicHost?: string;
    taskId?: string;
  },
): string {
  const secret = token.trim();
  if (!secret || /["\r\n]/.test(secret)) throw new Error('frps token 无效');
  const serverAddr = (endpoint?.serverAddr ?? '').trim() || 'host.docker.internal';
  const serverPort = endpoint?.serverPort && endpoint.serverPort > 0 ? endpoint.serverPort : 7000;
  const head = `serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${secret}"`;
  const publicHost = frpcDomain(endpoint?.publicHost, '');
  const taskId = (endpoint?.taskId ?? '').trim();
  if (isSaasPublicHost(publicHost) && taskId) {
    return renderSaasWorkspaceFrpc(secret, {
      publicHost,
      taskId,
      serverAddr,
      serverPort,
    });
  }
  const ideDomain = frpcDomain(endpoint?.ideDomain, WORKSPACE_IDE_HOST);
  const devDomain = frpcDomain(endpoint?.devDomain, WORKSPACE_DEV_HOST);
  const vncDomain = frpcDomain(endpoint?.vncDomain, WORKSPACE_VNC_HOST);
  return `${head}

${frpcProxy('workspace-ide', WORKSPACE_IDE_PORT, ideDomain)}

${frpcProxy('workspace-dev', WORKSPACE_DEV_PORT, devDomain)}

${frpcProxy('workspace-vnc', WORKSPACE_VNC_PORT, vncDomain)}
`;
}

/**
 * SaaS：三条代理共用公网域名，用路径分开。
 * dev 登记 `/<taskId>` 与 `/<taskId>-web`。frps 取最长路径，所以 `-code` / `-vnc` 不会被吞掉。
 * frps 不改路径。localPort 是节点适配器，由它再送到 5173 / 8080 / 6080。
 * 本机模式仍走 {@link renderWorkspaceFrpc}。
 */
export function renderSaasWorkspaceFrpc(
  token: string,
  endpoint: { publicHost: string; taskId: string; serverAddr?: string; serverPort?: number },
): string {
  const secret = token.trim();
  if (!secret || /["\r\n]/.test(secret)) throw new Error('frps token 无效');
  const publicHost = frpcDomain(endpoint.publicHost, '');
  if (!publicHost || publicHost === WORKSPACE_DEV_HOST || publicHost.endsWith('.localhost')) {
    throw new Error('SaaS 公网域名无效');
  }
  const taskId = endpoint.taskId.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskId)) throw new Error('taskId 无效');
  const serverAddr = (endpoint.serverAddr ?? '').trim() || 'host.docker.internal';
  const serverPort = endpoint.serverPort && endpoint.serverPort > 0 ? endpoint.serverPort : 7000;
  const domain = publicHost;
  return `serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${secret}"

[[proxies]]
name = "workspace-ide"
type = "http"
localIP = "127.0.0.1"
localPort = ${SAAS_IDE_LISTEN}
customDomains = ["${domain}"]
locations = ["/${taskId}-code"]

[[proxies]]
name = "workspace-dev"
type = "http"
localIP = "127.0.0.1"
localPort = ${SAAS_DEV_LISTEN}
customDomains = ["${domain}"]
locations = ["/${taskId}", "/${taskId}-web"]

[[proxies]]
name = "workspace-vnc"
type = "http"
localIP = "127.0.0.1"
localPort = ${SAAS_VNC_LISTEN}
customDomains = ["${domain}"]
locations = ["/${taskId}-vnc"]
`;
}

/** 任务切换后改写 SaaS frpc 路径。本机模式（没有公网域名）不改文件。 */
export function publishSaasFrpc(taskId: string, file = process.env.LINKAGENT_FRPC_PATH?.trim() || EMBEDDED_FRPC_PATH): void {
  const publicHost = process.env.LINKAGENT_PUBLIC_HOST?.trim() ?? '';
  if (!isSaasPublicHost(publicHost) || !existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  const token = raw.match(/auth\.token\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? '';
  if (!token || token.startsWith('nt_')) return;
  const endpoint = frpcEndpointFromEnv();
  writeFileSync(
    file,
    renderSaasWorkspaceFrpc(token, {
      publicHost,
      taskId,
      ...(endpoint.serverAddr ? { serverAddr: endpoint.serverAddr } : {}),
      ...(endpoint.serverPort ? { serverPort: endpoint.serverPort } : {}),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(join(dirname(file), 'current-task'), `${taskId.trim()}\n`, 'utf8');
  if (file !== EMBEDDED_FRPC_PATH) return;
  ensureSaasLocalAdapter(taskId);
  const child = spawn('pkill', ['-x', 'frpc'], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
}

/**
 * frpc 的 auth.token 必须和 frps 相同。登录插件可以把 nt_ 改写成服务端令牌通过 Login，
 * 但 0.60 随后用各自的 auth.token 加密控制连接，对不上就会在 proxy added 之后马上断开。
 */
export function frpcToken(file: string | undefined): string {
  const fromFile = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const fromEnv = (process.env.FRPS_TOKEN ?? '').trim();
  for (const token of [fromFile, fromEnv]) {
    if (token && !token.startsWith('nt_')) return token;
  }
  return '';
}

function frpcEndpointFromEnv(): {
  serverAddr?: string;
  serverPort?: number;
  publicHost?: string;
  taskId?: string;
} {
  const port = Number(process.env.FRPS_SERVER_PORT ?? '');
  const publicHost = process.env.LINKAGENT_PUBLIC_HOST?.trim();
  const taskId = process.env.LINKAGENT_TASK_ID?.trim();
  return {
    serverAddr: process.env.FRPS_SERVER_ADDR,
    serverPort: Number.isInteger(port) && port > 0 ? port : undefined,
    ...(publicHost ? { publicHost } : {}),
    ...(taskId ? { taskId } : {}),
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
    if (!token) {
      console.error('[node] 未写 frpc：需要与 frps 相同的 FRPS_TOKEN。nt_ 不能当作这条加密连接的令牌');
    } else if (existsSync(dirname(out))) {
      writeFileSync(out, renderWorkspaceFrpc(token, frpcEndpointFromEnv()), { encoding: 'utf8', mode: 0o600 });
      console.log(`[node] 已写入 ${out}，由容器入口启动 frpc`);
    }
    return { stop() {} };
  }
  if (!serveWeb.enabled) return { stop() {} };
  mkdirSync(launch.runtimeDir, { recursive: true });
  const composeFile = join(launch.runtimeDir, 'compose.yml');
  const frpcFile = join(launch.runtimeDir, 'frpc.toml');
  const token = frpcToken(launch.frpsTokenFile);
  const frpcMounted = token.length > 0;
  if (frpcMounted) {
    writeFileSync(frpcFile, renderWorkspaceFrpc(token, frpcEndpointFromEnv()), { encoding: 'utf8', mode: 0o600 });
  }
  writeFileSync(composeFile, renderIdeCompose(serveWeb, launch.workspaceDir, frpcMounted ? frpcFile : undefined), 'utf8');

  const dockerBin = dockerExecutable() ?? 'docker';

  const run = (action: 'up' | 'down') => {
    try {
      const child = spawnFn(dockerBin, serveWebDockerArgs(composeFile, action), {
        stdio: 'inherit',
        windowsHide: true,
        shell: process.platform === 'win32',
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
