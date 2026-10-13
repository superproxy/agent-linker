import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FRPS_VHOST_HTTP_PORT, NGINX_LISTEN_HOST, frpAsset, nginxAsset, type FrpAsset } from './assets.js';
import {
  APISIX_ADMIN_PORT,
  APISIX_PROJECT,
  ApisixAdmin,
  type ComposeStyle,
  renderApisixConfig,
  renderApisixDashboardConf,
  TASK_PUBLIC_HOST,
  taskCodeRouteId,
  taskDevRouteId,
  taskOpenRouteId,
  taskRouteId,
  taskOpenRouteUris,
  taskRouteUris,
  taskVncRouteId,
  FRPS_DASHBOARD_ROUTE_ID,
  FRPS_DASHBOARD_ROUTE_ID_LOOPBACK,
  frpsDashboardRouteSpec,
  gatewayNodeWsRouteSpec,
} from './apisix.js';
import { isSaasPublicHost, useFrpTaskPathRouting } from '@linkagent/shared';
import { renderFrpsConf } from './render.js';

/** Docker Compose 项目名：同机多安装时避免容器栈互相覆盖（可用 LINKAGENT_EDGE_PROJECT 覆盖） */
export function resolveEdgeComposeProject(installRoot?: string): string {
  const fromEnv = process.env.LINKAGENT_EDGE_PROJECT?.trim();
  if (fromEnv) {
    const safe = fromEnv.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
    if (safe) return safe;
  }
  if (installRoot) {
    const slug = basename(installRoot).replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
    if (slug) return `linkagent-edge-${slug}`;
  }
  return APISIX_PROJECT;
}

export interface GatewayEdgeOptions {
  toolsDir: string;
  runtimeDir: string;
  /** 安装根，用于推导独立 compose 项目名 */
  installRoot?: string;
  idePrefix: string;
  ideUpstream: string;
  /** 浏览器入口路径前缀，与 node.yaml hostCodeServerCompose.basePath 一致，默认 /vibe-ide */
  idePublicPath?: string;
  /** {taskId}-web.localhost 转到网关 */
  gatewayUpstream: string;
  /** 任务 -dev.localhost 转到容器内 npm run dev，默认 5173 */
  devUpstream?: string;
  /** VNC 转到 frps 的 HTTP 口。frpc 把容器 6080 登记成 vnc.localhost。默认 7080。 */
  vncUpstream?: string;
  /** frps Login 插件地址，例如 127.0.0.1:8787 */
  frpPluginAddr?: string;
  /** 浏览器入口主机。路径是 `/<taskId>-web|code|vnc`。 */
  publicHost?: string;
  /** 单测注入，避免访问本机 APISIX */
  adminFetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  extractFn?: (archive: string, dest: string) => Promise<void>;
}

export interface PreparedEdge {
  frpsBin: string | null;
  frpsConf: string;
  adminKey: string;
  adminUrl: string;
  composeProject: string;
}

export interface TaskHostChange {
  taskId: string;
  name: string;
  enabled: boolean;
  removed?: boolean;
}

export interface GatewayEdge {
  stop: () => void;
  /** 创建、开关或删除一条任务域名 */
  applyTaskHost: (change: TaskHostChange) => Promise<void>;
  /** 把 code-server 的任务域名和现有任务域名写进 APISIX */
  syncTaskHosts: (tasks: { id: string; name: string; enabled: boolean }[]) => Promise<void>;
}

function readOrCreateSecret(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(24).toString('hex');
  writeFileSync(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

async function downloadFile(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 ${res.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败 exit=${String(code)} ${archive}`));
    });
  });
}

async function ensureExtracted(
  destRoot: string,
  binaryPath: string,
  asset: { url: string },
  fetchImpl: typeof fetch,
  extractFn: (archive: string, dest: string) => Promise<void>,
): Promise<void> {
  if (existsSync(binaryPath)) return;
  mkdirSync(destRoot, { recursive: true });
  const archive = join(destRoot, 'download.bin');
  await downloadFile(asset.url, archive, fetchImpl);
  await extractFn(archive, destRoot);
}

async function ensureFrp(
  toolsDir: string,
  asset: FrpAsset,
  fetchImpl: typeof fetch,
  extractFn: (archive: string, dest: string) => Promise<void>,
): Promise<{ frps: string; frpc: string }> {
  const root = join(toolsDir, 'frp');
  const frps = join(root, asset.dirName, asset.frpsName);
  const frpc = join(root, asset.dirName, asset.frpcName);
  await ensureExtracted(root, frps, asset, fetchImpl, extractFn);
  return { frps, frpc };
}

/**
 * 网关进程的 PATH 常常比登录 shell 短，`spawn('docker')` 会 ENOENT。
 * 先查 PATH，再查常见安装位置（Linux `/usr/bin/docker`，Windows Docker Desktop）。
 */
function firstExisting(
  names: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  fixed: string[],
): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(sep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (exists(candidate)) return candidate;
    }
  }
  for (const candidate of fixed) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

export function dockerExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const names = platform === 'win32' ? ['docker.exe', 'docker.cmd', 'docker'] : ['docker'];
  const fixed = platform === 'win32'
    ? [
        join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        join(env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
      ]
    : ['/usr/bin/docker', '/usr/local/bin/docker'];
  return firstExisting(names, platform, env, exists, fixed);
}

export function dockerComposeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const names = platform === 'win32'
    ? ['docker-compose.exe', 'docker-compose.cmd', 'docker-compose']
    : ['docker-compose'];
  const fixed = platform === 'win32'
    ? [
        join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker-compose.exe'),
        join(env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker-compose.exe'),
      ]
    : ['/usr/bin/docker-compose', '/usr/local/bin/docker-compose'];
  return firstExisting(names, platform, env, exists, fixed);
}

export interface ComposeLauncher {
  command: string;
  style: ComposeStyle;
}

/** 优先 `docker compose` 插件，没有则退回独立的 `docker-compose`。 */
export function resolveComposeLauncher(
  dockerBin: string | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  canPlugin: (dockerBin: string) => boolean = dockerComposePluginAvailable,
): ComposeLauncher | null {
  if (dockerBin && canPlugin(dockerBin)) {
    return { command: dockerBin, style: 'plugin' };
  }
  const standalone = dockerComposeExecutable(platform, env, exists);
  if (standalone) return { command: standalone, style: 'standalone' };
  return null;
}

function dockerComposePluginAvailable(dockerBin: string): boolean {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(dockerBin);
  const result = spawnSync(dockerBin, ['compose', 'version'], {
    windowsHide: true,
    encoding: 'utf8',
    shell,
    timeout: 15_000,
  });
  return result.status === 0;
}

/**
 * 只写 frps / APISIX 配置并准备二进制。进程由 edge-server-ctl 启动，网关不 spawn。
 */
export async function prepareGatewayEdge(opts: GatewayEdgeOptions): Promise<PreparedEdge> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extractFn = opts.extractFn ?? extractArchive;
  mkdirSync(opts.runtimeDir, { recursive: true });
  const token = readOrCreateSecret(join(opts.runtimeDir, 'frps.token'));
  const dashboardPassword = readOrCreateSecret(join(opts.runtimeDir, 'frps.dashboard'));
  const frpsConf = join(opts.runtimeDir, 'frps.toml');
  writeFileSync(frpsConf, renderFrpsConf({
    token,
    dashboardPassword,
    ...(opts.frpPluginAddr ? { pluginAddr: opts.frpPluginAddr } : {}),
  }), 'utf8');
  const adminKey = readOrCreateSecret(join(opts.runtimeDir, 'apisix.admin-key'));
  writeFileSync(join(opts.runtimeDir, 'apisix-config.yaml'), renderApisixConfig(adminKey), 'utf8');
  const dashJwt = readOrCreateSecret(join(opts.runtimeDir, 'apisix-dashboard.jwt'));
  const dashPassword = readOrCreateSecret(join(opts.runtimeDir, 'apisix-dashboard.password'));
  writeFileSync(
    join(opts.runtimeDir, 'apisix-dashboard.yaml'),
    renderApisixDashboardConf({
      jwtSecret: dashJwt,
      username: 'admin',
      password: dashPassword,
    }),
    'utf8',
  );
  const frp = frpAsset(platform, arch);
  let frpsBin: string | null = null;
  if (frp) {
    try {
      const bins = await ensureFrp(opts.toolsDir, frp, fetchImpl, extractFn);
      frpsBin = bins.frps;
      writeFileSync(join(opts.runtimeDir, 'frpc.path'), `${bins.frpc}\n`, 'utf8');
      writeFileSync(join(opts.runtimeDir, 'frps.path'), `${bins.frps}\n`, 'utf8');
    } catch (err) {
      console.error(
        `[edge] frp 二进制准备失败（仍尝试同步 APISIX 路由）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    frpsBin,
    frpsConf,
    adminKey,
    adminUrl: `http://${NGINX_LISTEN_HOST}:${APISIX_ADMIN_PORT}`,
    composeProject: resolveEdgeComposeProject(opts.installRoot),
  };
}

/**
 * 写入边缘配置并返回路由同步客户端。frps 与 APISIX 不在本进程拉起。
 * 配置失败只打日志，不让网关进程退出。
 */
export async function startGatewayEdge(opts: GatewayEdgeOptions): Promise<GatewayEdge> {
  const noopEdge: GatewayEdge = {
    stop() {},
    async applyTaskHost() {},
    async syncTaskHosts() {},
  };
  let edgeApi: Omit<GatewayEdge, 'stop'> = noopEdge;

  try {
    const prepared = await prepareGatewayEdge(opts);
    quitStockNginx(opts.runtimeDir, opts.toolsDir, opts.platform ?? process.platform);
    const adminFetch = opts.adminFetch ?? fetch;
    const admin = new ApisixAdmin(prepared.adminUrl, prepared.adminKey, adminFetch);
    edgeApi = {
      async applyTaskHost(change) {
        const vncUpstream = opts.vncUpstream ?? `http://127.0.0.1:${FRPS_VHOST_HTTP_PORT}`;
        const host = opts.publicHost ?? TASK_PUBLIC_HOST;
        const taskId = change.taskId;
        if (change.removed) {
          await admin.remove(taskOpenRouteId(taskId));
          await admin.remove(taskRouteId(taskId));
          await admin.remove(taskCodeRouteId(taskId));
          await admin.remove(taskDevRouteId(taskId));
          await admin.remove(taskVncRouteId(taskId));
          return;
        }
        await admin.remove(taskDevRouteId(taskId));
        const codePrefix = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const frps = vncUpstream;
        const saas = useFrpTaskPathRouting(host);
        await admin.upsert({
          id: taskOpenRouteId(taskId),
          host,
          uris: taskOpenRouteUris(taskId),
          upstream: frps,
          enabled: change.enabled,
          priority: 1,
          ...(saas ? {} : { upstreamHost: 'dev.localhost', rewrite: [`^/${codePrefix}/?(.*)`, '/$1'] as [string, string] }),
        });
        await admin.upsert({
          id: taskRouteId(taskId),
          host,
          uris: taskRouteUris(taskId, 'web'),
          upstream: frps,
          enabled: change.enabled,
          priority: 10,
          ...(saas ? {} : { upstreamHost: 'dev.localhost', rewrite: [`^/${codePrefix}-web/?(.*)`, '/$1'] as [string, string] }),
        });
        await admin.upsert({
          id: taskCodeRouteId(taskId),
          host,
          uris: taskRouteUris(taskId, 'code'),
          upstream: frps,
          enabled: change.enabled,
          priority: 10,
          ...(saas
            ? {}
            : { upstreamHost: 'ide.localhost', rewrite: [`^/${codePrefix}-code/?(.*)`, '/$1'] as [string, string] }),
        });
        await admin.upsert({
          id: taskVncRouteId(taskId),
          host,
          uris: taskRouteUris(taskId, 'vnc'),
          upstream: frps,
          enabled: change.enabled,
          priority: 10,
          ...(saas ? {} : { upstreamHost: 'vnc.localhost', rewrite: [`^/${codePrefix}-vnc/?(.*)`, '/$1'] as [string, string] }),
        });
      },
      async syncTaskHosts(tasks) {
        // 9080 只走任务路径 /<taskId>-code；/vibe-ide 仅网关 /ui 同源代理，不写 APISIX。
        await admin.remove('code-localhost');
        await admin.remove('code-ide');
        const platformHost = opts.publicHost ?? TASK_PUBLIC_HOST;
        if (useFrpTaskPathRouting(platformHost)) {
          await admin.upsert(gatewayNodeWsRouteSpec(platformHost, opts.gatewayUpstream));
        }
        if (isSaasPublicHost(platformHost)) {
          await admin.remove(FRPS_DASHBOARD_ROUTE_ID);
          await admin.remove(FRPS_DASHBOARD_ROUTE_ID_LOOPBACK);
        } else {
          await admin.upsert(frpsDashboardRouteSpec(platformHost));
          await admin.upsert(frpsDashboardRouteSpec('127.0.0.1', FRPS_DASHBOARD_ROUTE_ID_LOOPBACK));
        }
        for (const task of tasks) {
          await edgeApi.applyTaskHost({ taskId: task.id, name: task.name, enabled: task.enabled });
        }
      },
    };

    if (!prepared.frpsBin) {
      console.error(`[edge] 当前平台没有 frp 安装包，跳过 frps 路径`);
    }
    console.log('[edge] 配置已写入。frps 与 APISIX 由 edge-server-ctl 启动，网关进程不拉起它们。');
  } catch (err) {
    console.error(`[edge] 配置写入失败：${err instanceof Error ? err.message : String(err)}`);
    edgeApi = noopEdge;
  }

  return { ...edgeApi, stop() {} };
}

/** 网关启动时常早于 APISIX Admin；失败则退避重试。 */
export async function syncTaskHostsWithRetry(
  edge: GatewayEdge,
  tasks: { id: string; name: string; enabled: boolean }[],
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 12;
  const delayMs = opts?.delayMs ?? 2500;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await edge.syncTaskHosts(tasks);
      if (i > 0) {
        console.log(`[edge] APISIX 路由同步成功（第 ${i + 1} 次尝试）`);
      }
      return;
    } catch (err) {
      last = err;
      if (i < attempts - 1) {
        console.warn(
          `[edge] APISIX 路由同步失败，${delayMs}ms 后重试：${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw last;
}

/** 旧的静态 nginx 若还占着自己的 8088，先退出。APISIX 数据面使用 9080。 */
function quitStockNginx(runtimeDir: string, toolsDir: string, platform: NodeJS.Platform): void {
  const asset = nginxAsset(platform);
  if (!asset) return;
  const bin = join(toolsDir, 'nginx', asset.dirName, asset.binaryName);
  const conf = join(runtimeDir, 'nginx.conf');
  if (!existsSync(bin) || !existsSync(conf) || !existsSync(join(runtimeDir, 'nginx.pid'))) return;
  const child = spawn(bin, ['-p', runtimeDir, '-c', conf, '-s', 'quit'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.error(`[edge] nginx 退出失败：${err instanceof Error ? err.message : String(err)}`);
  });
}
