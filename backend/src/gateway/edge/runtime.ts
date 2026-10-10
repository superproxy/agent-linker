import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NGINX_LISTEN_HOST, frpAsset, nginxAsset, type FrpAsset } from './assets.js';
import {
  APISIX_ADMIN_PORT,
  APISIX_PROJECT,
  ApisixAdmin,
  type ComposeStyle,
  renderApisixConfig,
  TASK_PUBLIC_HOST,
  taskCodeRouteId,
  taskDevRouteId,
  taskRouteId,
  taskRouteUri,
  taskVncRouteId,
} from './apisix.js';
import { renderFrpsConf } from './render.js';

export interface GatewayEdgeOptions {
  toolsDir: string;
  runtimeDir: string;
  idePrefix: string;
  ideUpstream: string;
  /** {taskId}-web.localhost 转到网关 */
  gatewayUpstream: string;
  /** 任务 -dev.localhost 转到容器内 npm run dev，默认 5173 */
  devUpstream?: string;
  /** 任务 -vnc.localhost 转到容器内 noVNC，默认 6080 */
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
 * 只写 frps / APISIX 配置并准备二进制。进程由 scripts/edge.sh 启动，网关不 spawn。
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
  const frp = frpAsset(platform, arch);
  let frpsBin: string | null = null;
  if (frp) {
    const bins = await ensureFrp(opts.toolsDir, frp, fetchImpl, extractFn);
    frpsBin = bins.frps;
    writeFileSync(join(opts.runtimeDir, 'frpc.path'), `${bins.frpc}\n`, 'utf8');
    writeFileSync(join(opts.runtimeDir, 'frps.path'), `${bins.frps}\n`, 'utf8');
  }
  return {
    frpsBin,
    frpsConf,
    adminKey,
    adminUrl: `http://${NGINX_LISTEN_HOST}:${APISIX_ADMIN_PORT}`,
    composeProject: APISIX_PROJECT,
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
        const vncUpstream = opts.vncUpstream ?? 'http://127.0.0.1:6080';
        const host = opts.publicHost ?? TASK_PUBLIC_HOST;
        const taskId = change.taskId;
        if (change.removed) {
          await admin.remove(taskRouteId(taskId));
          await admin.remove(taskCodeRouteId(taskId));
          await admin.remove(taskDevRouteId(taskId));
          await admin.remove(taskVncRouteId(taskId));
          return;
        }
        await admin.remove(taskDevRouteId(taskId));
        const codePrefix = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await admin.upsert({
          id: taskRouteId(taskId),
          host,
          uri: taskRouteUri(taskId, 'web'),
          upstream: opts.gatewayUpstream,
          enabled: change.enabled,
        });
        await admin.upsert({
          id: taskCodeRouteId(taskId),
          host,
          uri: taskRouteUri(taskId, 'code'),
          upstream: opts.ideUpstream,
          enabled: change.enabled,
          rewrite: [`^/${codePrefix}-code/?(.*)`, '/vibe-ide/$1'],
        });
        await admin.upsert({
          id: taskVncRouteId(taskId),
          host,
          uri: taskRouteUri(taskId, 'vnc'),
          upstream: vncUpstream,
          enabled: change.enabled,
          rewrite: [`^/${codePrefix}-vnc/?(.*)`, '/$1'],
        });
      },
      async syncTaskHosts(tasks) {
        const host = opts.publicHost ?? TASK_PUBLIC_HOST;
        await admin.upsert({
          id: 'code-localhost',
          host,
          uri: '/vibe-ide*',
          upstream: opts.ideUpstream,
          enabled: true,
        });
        await admin.remove('code-ide');
        for (const task of tasks) {
          await edgeApi.applyTaskHost({ taskId: task.id, name: task.name, enabled: task.enabled });
        }
      },
    };

    if (!prepared.frpsBin) {
      console.error(`[edge] 当前平台没有 frp 安装包，跳过 frps 路径`);
    }
    console.log('[edge] 配置已写入。frps 与 APISIX 由 scripts/edge.sh 启动，网关进程不拉起它们。');
  } catch (err) {
    console.error(`[edge] 配置写入失败：${err instanceof Error ? err.message : String(err)}`);
    edgeApi = noopEdge;
  }

  return { ...edgeApi, stop() {} };
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
