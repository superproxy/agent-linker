import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import {
  TASK_PUBLIC_HOST,
  taskPublicPath,
  taskSaasCodeProxyBasePath,
  taskSaasDevFrpcLocations,
  useFrpTaskPathRouting,
  type NodeSection,
} from '@linkagent/shared';
import { dockerExecutable } from '../gateway/edge/runtime.js';
import {
  closeSaasLocalAdapters,
  ensureSaasLocalAdapter,
  getSaasDevTargetPort,
  SAAS_DEV_LISTEN,
  SAAS_IDE_LISTEN,
  SAAS_VNC_LISTEN,
} from './saas-path.js';
import { nodeRunsInsideIdeContainer } from './dev-port.js';

export type HostCodeServerComposeConfig = NodeSection['hostCodeServerCompose'];
/** @deprecated 使用 {@link HostCodeServerComposeConfig} */
export type ServeWebConfig = HostCodeServerComposeConfig;

export interface ServeWebLaunch {
  hostCodeServerCompose: HostCodeServerComposeConfig;
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
    /** 宿主机原生 frpc 时 code-server 监听口（如 8010）；容器内仍为 8080。 */
    ideLocalPort?: number;
  },
): string {
  const secret = token.trim();
  if (!secret || /["\r\n]/.test(secret)) throw new Error('frps token 无效');
  const serverAddr = (endpoint?.serverAddr ?? '').trim() || '127.0.0.1';
  const serverPort = endpoint?.serverPort && endpoint.serverPort > 0 ? endpoint.serverPort : 7000;
  const head = `serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${secret}"`;
  const publicHost = frpcDomain(endpoint?.publicHost, TASK_PUBLIC_HOST);
  const taskId = (endpoint?.taskId ?? '').trim() || 'default';
  const legacyHosts = process.env.LINKAGENT_FRPC_LEGACY_HOSTS === '1';
  if (!legacyHosts && useFrpTaskPathRouting(publicHost)) {
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
  const idePort =
    endpoint?.ideLocalPort != null && endpoint.ideLocalPort > 0 && endpoint.ideLocalPort <= 65535
      ? endpoint.ideLocalPort
      : WORKSPACE_IDE_PORT;
  return `${head}

${frpcProxy('workspace-ide', idePort, ideDomain)}

${frpcProxy('workspace-dev', WORKSPACE_DEV_PORT, devDomain)}

${frpcProxy('workspace-vnc', WORKSPACE_VNC_PORT, vncDomain)}
`;
}

/**
 * SaaS：三条代理共用公网域名，用路径分开。
 * dev 只登记 `/<taskId>-web` → 本机 {@link SAAS_DEV_LISTEN}（15173）适配器；适配器剥前缀后转发 Vite 动态口（非 5173/15173）。
 * frps 不改路径。code/vnc 的 localPort 为 18080/16080 适配器，再送到 8080/6080。
 * 本机模式仍走 {@link renderWorkspaceFrpc}。
 */
export function renderSaasWorkspaceFrpc(
  token: string,
  endpoint: { publicHost: string; taskId: string; serverAddr?: string; serverPort?: number },
): string {
  const secret = token.trim();
  if (!secret || /["\r\n]/.test(secret)) throw new Error('frps token 无效');
  const publicHost = frpcDomain(endpoint.publicHost, '');
  if (!publicHost || publicHost === WORKSPACE_DEV_HOST || publicHost === WORKSPACE_VNC_HOST) {
    throw new Error('浏览器入口域名无效');
  }
  if (!useFrpTaskPathRouting(publicHost)) {
    throw new Error('浏览器入口域名无效');
  }
  const taskId = endpoint.taskId.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskId)) throw new Error('taskId 无效');
  const serverAddr = (endpoint.serverAddr ?? '').trim() || 'host.docker.internal';
  const serverPort = endpoint.serverPort && endpoint.serverPort > 0 ? endpoint.serverPort : 7000;
  const domain = publicHost;
  const devLocations = taskSaasDevFrpcLocations(taskId);
  const codeLocation = taskPublicPath(taskId, 'code');
  const vncLocation = taskPublicPath(taskId, 'vnc');
  const loc = (items: string[]) => `[${items.map((item) => `"${item}"`).join(', ')}]`;
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
locations = ${loc([codeLocation])}

[[proxies]]
name = "workspace-dev"
type = "http"
localIP = "127.0.0.1"
localPort = ${SAAS_DEV_LISTEN}
customDomains = ["${domain}"]
locations = ${loc(devLocations)}

[[proxies]]
name = "workspace-vnc"
type = "http"
localIP = "127.0.0.1"
localPort = ${SAAS_VNC_LISTEN}
customDomains = ["${domain}"]
locations = ${loc([vncLocation])}
`;
}

function browserEntryPublicHost(): string {
  const localStack = (process.env.LINKAGENT_LOCAL_STACK ?? '').trim();
  if (localStack === '1' || localStack.toLowerCase() === 'true') {
    return frpcDomain(TASK_PUBLIC_HOST, TASK_PUBLIC_HOST);
  }
  return frpcDomain(process.env.LINKAGENT_PUBLIC_HOST?.trim() || TASK_PUBLIC_HOST, TASK_PUBLIC_HOST);
}

function frpcServerAddrForPublish(inContainer: boolean, tomlAddr: string | undefined, envAddr: string | undefined): string {
  const fromEnv = (envAddr ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromToml = (tomlAddr ?? '').trim();
  if (!inContainer) {
    if (!fromToml || fromToml === 'host.docker.internal') return '127.0.0.1';
    return fromToml;
  }
  return fromToml || 'host.docker.internal';
}

function saasAdapterPortsFromEnv(): { dev: number; code: number; vnc: number } {
  const code = Number(process.env.LINKAGENT_IDE_LOCAL_PORT ?? '');
  return {
    dev: getSaasDevTargetPort(),
    code: Number.isInteger(code) && code > 0 && code <= 65535 ? code : WORKSPACE_IDE_PORT,
    vnc: WORKSPACE_VNC_PORT,
  };
}

let hostFrpcReload: ((file: string) => void) | null = null;

/** 宿主机 frpc 子进程注册 reload，任务切换后重读 toml。 */
export function registerHostFrpcReload(reload: (file: string) => void): void {
  hostFrpcReload = reload;
}

function frpcTokenFromFileOrEnv(file: string): string {
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    const fromFile = raw.match(/auth\.token\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? '';
    if (fromFile && !fromFile.startsWith('nt_')) return fromFile;
  }
  return frpcToken(undefined);
}

function frpcServerFromToml(file: string): { serverAddr?: string; serverPort?: number } {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  const serverAddr = raw.match(/serverAddr\s*=\s*"([^"]*)"/)?.[1]?.trim();
  const portRaw = raw.match(/serverPort\s*=\s*(\d+)/)?.[1];
  const serverPort = portRaw ? Number(portRaw) : undefined;
  return {
    ...(serverAddr ? { serverAddr } : {}),
    ...(Number.isInteger(serverPort) && serverPort > 0 ? { serverPort } : {}),
  };
}

function frpcPublishInContainer(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return normalized.endsWith('/etc/linkagent/frpc.toml') || normalized === EMBEDDED_FRPC_PATH.replace(/\\/g, '/');
}

/** 任务切换后改写 frpc locations（本机 ide.localhost 与 SaaS 公网域均走路径）。 */
export function publishSaasFrpc(taskId: string, file = process.env.LINKAGENT_FRPC_PATH?.trim() || EMBEDDED_FRPC_PATH): void {
  const publicHost = browserEntryPublicHost();
  if (!useFrpTaskPathRouting(publicHost)) return;
  const id = taskId.trim();
  if (!id) return;
  const token = frpcTokenFromFileOrEnv(file);
  if (!token) return;
  const inContainer = frpcPublishInContainer(file);
  const fromToml = frpcServerFromToml(file);
  const envAddr = (process.env.FRPS_SERVER_ADDR ?? '').trim();
  const envPort = Number(process.env.FRPS_SERVER_PORT ?? '');
  const fromEnv = frpcEndpointForWrite(inContainer);
  const serverAddr = frpcServerAddrForPublish(inContainer, fromToml.serverAddr, envAddr || undefined);
  const endpoint = {
    serverAddr,
    ...(Number.isInteger(envPort) && envPort > 0
      ? { serverPort: envPort }
      : fromToml.serverPort
        ? { serverPort: fromToml.serverPort }
        : fromEnv.serverPort
          ? { serverPort: fromEnv.serverPort }
          : {}),
  };
  const body = renderSaasWorkspaceFrpc(token, {
    publicHost,
    taskId: id,
    ...(endpoint.serverAddr ? { serverAddr: endpoint.serverAddr } : {}),
    ...(endpoint.serverPort ? { serverPort: endpoint.serverPort } : {}),
  });
  const frpcDir = dirname(file);
  mkdirSync(frpcDir, { recursive: true });
  writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(frpcDir, 'current-task'), `${id}\n`, 'utf8');
  ensureSaasLocalAdapter(id, saasAdapterPortsFromEnv());
  if (hostFrpcReload && existsSync(file)) {
    hostFrpcReload(file);
    return;
  }
  if (file !== EMBEDDED_FRPC_PATH) return;
  const child = spawn('pkill', ['-x', 'frpc'], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
}

/** SaaS 路径下 code-server 静态资源前缀，须与 frpc `taskPublicPath(id, 'code')` 一致。 */
export function saasCodeProxyBasePath(taskId: string): string {
  return taskSaasCodeProxyBasePath(taskId);
}

/** 聚合容器：按任务重启 code-server（--abs-proxy-base-path / trusted-origins 与公网路径对齐）。 */
export function restartBundledCodeServer(taskId: string, workspaceDir: string): void {
  if (!nodeRunsInsideIdeContainer()) return;
  const publicHost = browserEntryPublicHost();
  if (!useFrpTaskPathRouting(publicHost)) return;
  const id = taskId.trim();
  const dir = workspaceDir.trim();
  if (!id || !dir) return;
  const base = saasCodeProxyBasePath(id);
  const origins = `https://${publicHost},http://${publicHost},*.localhost:9080,*.localhost:8088`;
  const logFile = '/tmp/linkagent-code-server.log';
  const start = () => {
    let out = 2;
    let err = 2;
    try {
      out = openSync(logFile, 'a');
      err = out;
    } catch {
      /* 忽略 */
    }
    const child = spawn(
      '/usr/bin/dumb-init',
      [
        '/usr/bin/code-server',
        '--auth',
        'none',
        '--bind-addr',
        '0.0.0.0:8080',
        '--trusted-origins',
        origins,
        '--abs-proxy-base-path',
        base,
        dir,
      ],
      { detached: true, stdio: ['ignore', out, err], windowsHide: true },
    );
    child.unref();
    child.on('error', (e) => {
      try {
        appendFileSync(logFile, `[node] code-server 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
      } catch {
        /* 忽略 */
      }
    });
    console.log(`[node] code-server 已按 SaaS 路径重启 base=${base} cwd=${dir}`);
  };
  const killer = spawn(
    'sh',
    ['-c', 'pkill -f "lib/code-server/out/node/entry" 2>/dev/null; pkill -f "dumb-init /usr/bin/code-server" 2>/dev/null; exit 0'],
    { stdio: 'ignore', windowsHide: true },
  );
  killer.on('exit', () => {
    setTimeout(start, 450);
  });
  killer.on('error', () => {
    start();
  });
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

export function resolveFrpcBin(frpsTokenFile: string | undefined): string | null {
  if (!frpsTokenFile) return null;
  const pathFile = join(dirname(frpsTokenFile), 'frpc.path');
  if (!existsSync(pathFile)) return null;
  const bin = readFileSync(pathFile, 'utf8').trim();
  return bin && existsSync(bin) ? bin : null;
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

/** 容器内 frpc 连宿主机 frps；宿主机原生 frpc 用 127.0.0.1。 */
function frpcEndpointForWrite(inContainer: boolean): ReturnType<typeof frpcEndpointFromEnv> {
  const ep = frpcEndpointFromEnv();
  if (ep.serverAddr?.trim()) return ep;
  return { ...ep, serverAddr: inContainer ? 'host.docker.internal' : '127.0.0.1' };
}

function dockerVolumeHost(workspaceDir: string): string {
  return workspaceDir.replace(/\\/g, '/');
}

export function serveWebBasePath(basePath: string): string {
  const withSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withSlash.replace(/\/+$/, '') || '/vibe-ide';
}

/**
 * node 只发布 code-server（镜像便于安装）。frpc 在宿主机共享，不挂载进本容器（形态 B / enhance）。
 * 形态 C 聚合镜像在容器内写 frpc，不走本 compose。
 */
export function currentTaskMarkerPath(runtimeDir: string): string {
  return join(runtimeDir, 'current-task');
}

export function writeCurrentTaskMarker(runtimeDir: string, taskId: string): string {
  mkdirSync(runtimeDir, { recursive: true });
  const file = currentTaskMarkerPath(runtimeDir);
  writeFileSync(file, `${taskId.trim()}\n`, 'utf8');
  return file;
}

/**
 * 形态 B：容器只跑 code-server + VNC，**不**把 5173 发布到宿主机。
 * Vite dev 由宿主机 node 在 switchTask 时监听动态端口（15173 适配器转发）。
 */
export function renderIdeCompose(
  opts: ServeWebConfig,
  workspaceDir: string,
  frpcFile?: string,
  currentTaskFile?: string,
): string {
  const prefix = serveWebBasePath(opts.basePath);
  const isolatedNodeModules = !opts.useHostNodeModules;
  const volumes = [`${dockerVolumeHost(workspaceDir)}:${IDE_CONTAINER_WORKSPACE}`];
  if (isolatedNodeModules) {
    volumes.push(`${NODE_MODULES_VOLUME}:${IDE_CONTAINER_WORKSPACE}/node_modules`);
  }
  if (frpcFile) volumes.push(`${dockerVolumeHost(frpcFile)}:/etc/linkagent/frpc.toml:ro`);
  if (currentTaskFile) {
    volumes.push(`${dockerVolumeHost(currentTaskFile)}:/etc/linkagent/current-task:ro`);
  }
  const service: Record<string, unknown> = {
    image: opts.image,
    container_name: CODE_CONTAINER,
    restart: 'unless-stopped',
    user: '0:0',
    shm_size: '1gb',
    extra_hosts: ['host.docker.internal:host-gateway'],
    environment: { LINKAGENT_DEV_BY_NODE: '1' },
    entrypoint: ['/usr/local/bin/linkagent-entrypoint.sh'],
    command: [
      '--auth', 'none',
      '--bind-addr', '0.0.0.0:8080',
      '--abs-proxy-base-path', prefix,
      '--trusted-origins', IDE_TRUSTED_ORIGIN,
      IDE_CONTAINER_WORKSPACE,
    ],
    ports: [`${opts.host}:${opts.port}:8080`, `127.0.0.1:${WORKSPACE_VNC_PORT}:${WORKSPACE_VNC_PORT}`],
    volumes,
  };
  const doc: Record<string, unknown> = {
    services: {
      'code-serve-web': service,
    },
  };
  if (isolatedNodeModules) {
    doc.volumes = { [NODE_MODULES_VOLUME]: {} };
  }
  return stringify(doc);
}

export function serveWebDockerArgs(composeFile: string, action: 'up' | 'down', forceRecreate = false): string[] {
  if (action === 'up') {
    const args = ['compose', '-f', composeFile, 'up', '-d'];
    if (forceRecreate) args.push('--force-recreate');
    return args;
  }
  return ['compose', '-f', composeFile, 'down'];
}

export interface ServeWebHandle {
  stop: () => void;
  /** 切换激活任务：重挂工作区并重建 IDE 容器（dev / code-server / VNC 由入口脚本重启）。 */
  switchTask: (taskId: string, cwd: string) => void;
}

/**
 * Docker 聚合镜像里 IDE / VNC / frpc 已由入口脚本拉起。
 * `LINKAGENT_NODE_SERVE_WEB=0|false|off` 时 node 不再 compose 第二个 code-server。
 */
export function nodeServeWebSuppressed(flag: string | undefined): boolean {
  const raw = (flag ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off';
}

/** `pnpm local:stack:start:enhance`：临时拉起 Docker code-server（8010），不要求 node.yaml hostCodeServerCompose.enabled。 */
export function stackEnhanceIdeEnabled(): boolean {
  const raw = (process.env.LINKAGENT_LOCAL_STACK_ENHANCE ?? process.env.LINKAGENT_SERVE_WEB_ENHANCE ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** node 启动时只拉起 code-server。未启用或 docker 不存在时不打断节点回连。 */
export function startNodeServeWeb(
  launch: ServeWebLaunch,
  spawnFn: ServeWebSpawn = spawn as ServeWebSpawn,
): ServeWebHandle {
  const compose = launch.hostCodeServerCompose;
  const enhanceIde = stackEnhanceIdeEnabled();
  const useDockerIde = compose.enabled || enhanceIde;
  const suppressed = nodeServeWebSuppressed(process.env.LINKAGENT_NODE_SERVE_WEB);
  if (suppressed && !enhanceIde) {
    console.log('[node] LINKAGENT_NODE_SERVE_WEB 已关闭 compose，IDE 由容器入口拉起');
    const token = frpcToken(launch.frpsTokenFile);
    const out = launch.frpcPath ?? EMBEDDED_FRPC_PATH;
    if (!token) {
      console.error('[node] 未写 frpc：需要与 frps 相同的 FRPS_TOKEN。nt_ 不能当作这条加密连接的令牌');
    } else {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderWorkspaceFrpc(token, frpcEndpointForWrite(true)), { encoding: 'utf8', mode: 0o600 });
      console.log(`[node] 已写入 ${out}，由容器入口启动 frpc`);
    }
    return { stop() {}, switchTask() {} };
  }
  if (!useDockerIde) {
    const frpcOnly = startNativeHostFrpc(launch, compose);
    return { ...frpcOnly, switchTask() {} };
  }
  if (enhanceIde && !compose.enabled) {
    console.log('[node] LINKAGENT_LOCAL_STACK_ENHANCE：Docker code-server（宿主机共享 frpc）');
  }
  if (useDockerIde && !process.env.LINKAGENT_DEV_BY_NODE?.trim()) {
    process.env.LINKAGENT_DEV_BY_NODE = '1';
  }
  mkdirSync(launch.runtimeDir, { recursive: true });
  const composeFile = join(launch.runtimeDir, 'compose.yml');
  let mountedWorkspace = launch.workspaceDir;
  let activeTaskId = '';

  const dockerBin = dockerExecutable() ?? 'docker';
  let hostFrpc: { stop: () => void } = { stop() {} };

  const writeCompose = (workspaceDir: string, taskId: string, recreate: boolean) => {
    mountedWorkspace = workspaceDir;
    activeTaskId = taskId.trim();
    const marker = activeTaskId ? writeCurrentTaskMarker(launch.runtimeDir, activeTaskId) : undefined;
    writeFileSync(composeFile, renderIdeCompose(compose, workspaceDir, undefined, marker), 'utf8');
    run('up', recreate);
  };

  const run = (action: 'up' | 'down', forceRecreate = false) => {
    try {
      const child = spawnFn(dockerBin, serveWebDockerArgs(composeFile, action, forceRecreate), {
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

  hostFrpc = startNativeHostFrpc(launch, compose);

  const switchTask = (taskId: string, cwd: string) => {
    const id = taskId.trim();
    const dir = cwd.trim();
    if (!id || !dir) return;
    if (id === activeTaskId && dir === mountedWorkspace) return;
    console.log(
      `[node] IDE 跟随激活任务 ${id}，重建 ${CODE_CONTAINER}（dev/code-server/vnc）→ ${dir}`,
    );
    writeCompose(dir, id, true);
  };

  if (mountedWorkspace.trim()) {
    console.log(
      `[node] 启动 IDE 容器 ${CODE_CONTAINER}（仅 code-server/dev/vnc），发布 ${compose.host}:${compose.port}；frpc 在宿主机`,
    );
    writeCompose(mountedWorkspace, '', false);
  } else {
    console.log('[node] IDE 容器等待网关下发激活任务（switchTask）后再启动');
  }

  return {
    stop() {
      hostFrpc.stop();
      closeSaasLocalAdapters();
      run('down');
    },
    switchTask,
  };
}

/** 形态 A：不启 IDE 容器，在宿主机拉起 frpc，登记 dev/ide/vnc.localhost → 本机端口。 */
function startNativeHostFrpc(launch: ServeWebLaunch, compose: HostCodeServerComposeConfig): { stop: () => void } {
  const token = frpcToken(launch.frpsTokenFile);
  if (!token) {
    console.warn('[node] hostCodeServerCompose 未启用且未写 frpc：缺少 .runtime-state/edge/frps.token（或 FRPS_TOKEN）');
    return { stop() {} };
  }
  mkdirSync(launch.runtimeDir, { recursive: true });
  const frpcFile = join(launch.runtimeDir, 'frpc.toml');
  const idePort = compose.port > 0 ? compose.port : WORKSPACE_IDE_PORT;
  const bootTask = process.env.LINKAGENT_TASK_ID?.trim() || 'default';
  process.env.LINKAGENT_IDE_LOCAL_PORT = String(idePort);
  writeFileSync(
    frpcFile,
    renderWorkspaceFrpc(token, {
      ...frpcEndpointForWrite(false),
      publicHost: browserEntryPublicHost(),
      taskId: bootTask,
      ideLocalPort: idePort,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  ensureSaasLocalAdapter(bootTask, { dev: WORKSPACE_DEV_PORT, code: idePort, vnc: WORKSPACE_VNC_PORT });
  const bin = resolveFrpcBin(launch.frpsTokenFile);
  if (!bin) {
    console.warn(`[node] 未找到 frpc 二进制（${join(dirname(launch.frpsTokenFile ?? ''), 'frpc.path')}），跳过宿主机 frpc`);
    return { stop() {} };
  }
  let child: ChildProcess | null = null;
  const startFrpc = () => {
    if (child && !child.killed) child.kill('SIGTERM');
    try {
      child = spawn(bin, ['-c', frpcFile], { stdio: 'inherit', windowsHide: true, shell: false });
      child.on('error', (err) => {
        console.error(`[node] frpc 启动失败：${err instanceof Error ? err.message : String(err)}`);
      });
      child.on('exit', (code) => {
        if (code && code !== 0) console.error(`[node] frpc 退出 code=${String(code)}`);
      });
    } catch (err) {
      console.error(`[node] frpc 启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  registerHostFrpcReload(() => startFrpc());
  startFrpc();
  const pathMode = useFrpTaskPathRouting(browserEntryPublicHost());
  console.log(
    `[node] 宿主机 frpc 已启动（${frpcFile}，${pathMode ? `路径 ${browserEntryPublicHost()}/<taskId>-*` : `三 Host → ${idePort}/5173/6080`}）`,
  );
  return {
    stop() {
      hostFrpcReload = null;
      closeSaasLocalAdapters();
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}
