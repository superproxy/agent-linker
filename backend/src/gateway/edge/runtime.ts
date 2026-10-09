import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FRPS_BIND_PORT, NGINX_LISTEN_HOST, NGINX_LISTEN_PORT, frpAsset, nginxAsset, type FrpAsset } from './assets.js';
import {
  APISIX_ADMIN_PORT,
  ApisixAdmin,
  apisixComposeArgs,
  renderApisixCompose,
  renderApisixConfig,
  TASK_PUBLIC_HOST,
  taskCodeRouteId,
  taskDevRouteId,
  taskRouteId,
  taskRouteUri,
  taskVncRouteId,
} from './apisix.js';
import { renderFrpsConf } from './render.js';

export interface EdgeChild {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

export type EdgeSpawn = (
  command: string,
  args: string[],
  options: { cwd?: string; windowsHide: true; stdio: 'ignore' },
) => EdgeChild;

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
  spawnFn?: EdgeSpawn;
  extractFn?: (archive: string, dest: string) => Promise<void>;
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

function watchChild(name: string, child: EdgeChild): void {
  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[edge] ${name} 启动失败：${message}`);
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[edge] ${name} 退出 code=${String(code)}`);
  });
}

async function waitForApisix(adminUrl: string, apiKey: string, fetchImpl: typeof fetch): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${adminUrl}/apisix/admin/routes`, { headers: { 'X-API-KEY': apiKey } });
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`APISIX 管理接口未就绪：${last}`);
}

/**
 * 安装并拉起 frps 与 APISIX。任务域名由 Admin API 动态创建和开关。
 * 安装或启动失败只打日志，不让网关进程退出。
 */
export async function startGatewayEdge(opts: GatewayEdgeOptions): Promise<GatewayEdge> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const spawnFn = opts.spawnFn ?? (spawn as EdgeSpawn);
  const extractFn = opts.extractFn ?? extractArchive;
  const children: EdgeChild[] = [];
  const noopEdge: GatewayEdge = {
    stop() {},
    async applyTaskHost() {},
    async syncTaskHosts() {},
  };
  let edgeApi = noopEdge;
  let composeFile = '';

  const stop = () => {
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 进程已退出
      }
    }
    if (!composeFile) return;
    try {
      const down = spawnFn('docker', apisixComposeArgs(composeFile, 'down'), { windowsHide: true, stdio: 'ignore' });
      watchChild('apisix', down);
    } catch {
      // docker 不在时忽略
    }
  };

  try {
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
    composeFile = join(opts.runtimeDir, 'apisix-compose.yml');
    writeFileSync(join(opts.runtimeDir, 'apisix-config.yaml'), renderApisixConfig(adminKey), 'utf8');
    writeFileSync(composeFile, renderApisixCompose(), 'utf8');
    const adminUrl = `http://${NGINX_LISTEN_HOST}:${APISIX_ADMIN_PORT}`;
    const adminFetch = opts.adminFetch ?? fetch;
    const admin = new ApisixAdmin(adminUrl, adminKey, adminFetch);
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

    const frp = frpAsset(platform, arch);
    if (frp) {
      const bins = await ensureFrp(opts.toolsDir, frp, fetchImpl, extractFn);
      writeFileSync(join(opts.runtimeDir, 'frpc.path'), `${bins.frpc}\n`, 'utf8');
      const frpsChild = spawnFn(bins.frps, ['-c', frpsConf], { windowsHide: true, stdio: 'ignore' });
      watchChild('frps', frpsChild);
      children.push(frpsChild);
      console.log(`[edge] frps 已启动，控制端口 ${FRPS_BIND_PORT}`);
    } else {
      console.error(`[edge] 当前平台 ${platform}/${arch} 没有 frp 安装包，跳过 frps`);
    }

    quitStockNginx(opts.runtimeDir, opts.toolsDir, platform, spawnFn);
    const apisixChild = spawnFn('docker', apisixComposeArgs(composeFile, 'up'), { windowsHide: true, stdio: 'ignore' });
    watchChild('apisix', apisixChild);
    children.push(apisixChild);
    if (!opts.spawnFn) await waitForApisix(adminUrl, adminKey, adminFetch);
    console.log(`[edge] APISIX 已在 ${NGINX_LISTEN_HOST}:${NGINX_LISTEN_PORT} 监听，管理接口 ${adminUrl}`);
  } catch (err) {
    console.error(`[edge] 安装或启动失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return { ...edgeApi, stop };
}

/** 旧的静态 nginx 还占着 8088 时先退出，把端口留给 APISIX。 */
function quitStockNginx(runtimeDir: string, toolsDir: string, platform: NodeJS.Platform, spawnFn: EdgeSpawn): void {
  const asset = nginxAsset(platform);
  if (!asset) return;
  const bin = join(toolsDir, 'nginx', asset.dirName, asset.binaryName);
  const conf = join(runtimeDir, 'nginx.conf');
  if (!existsSync(bin) || !existsSync(conf) || !existsSync(join(runtimeDir, 'nginx.pid'))) return;
  const child = spawnFn(bin, ['-p', runtimeDir, '-c', conf, '-s', 'quit'], { windowsHide: true, stdio: 'ignore' });
  watchChild('nginx', child);
}
