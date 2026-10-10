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

/**
 * 网关进程的 PATH 常常比登录 shell 短，`spawn('docker')` 会 ENOENT。
 * 先查 PATH，再查常见安装位置（Linux `/usr/bin/docker`，Windows Docker Desktop）。
 */
export function dockerExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['docker.exe', 'docker.cmd', 'docker'] : ['docker'];
  for (const dir of pathValue.split(sep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (exists(candidate)) return candidate;
    }
  }
  const fixed = platform === 'win32'
    ? [
        join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        join(env.LOCALAPPDATA || '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
      ]
    : ['/usr/bin/docker', '/usr/local/bin/docker'];
  for (const candidate of fixed) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

function edgeProcName(command: string): string {
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? command;
  if (base.startsWith('frps')) return 'frps';
  if (base === 'docker' || base === 'docker.exe' || base === 'docker.cmd') return 'apisix';
  if (base.startsWith('nginx')) return 'nginx';
  return base;
}

/** docker / frps 的失败原因在子进程输出里。stdio 丢掉的话只剩一个退出码。 */
function attachOutput(name: string, child: ChildProcess): void {
  const follow = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    let pending = '';
    stream.on('data', (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) console.error(`[edge] ${name} ${trimmed}`);
      }
    });
  };
  follow(child.stdout);
  follow(child.stderr);
}

function watchChild(name: string, child: EdgeChild, onExit?: (code: number) => void): void {
  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[edge] ${name} 启动失败：${message}`);
  });
  child.on('exit', (code) => {
    if (typeof code !== 'number' || code === 0) return;
    onExit?.(code);
    const hint = name === 'apisix' && code === 125
      ? '（docker 未能创建容器。看上面的 docker 输出；常见是未安装 compose 插件，或 127.0.0.1:8088、9180 已被占用）'
      : '';
    console.error(`[edge] ${name} 退出 code=${String(code)}${hint}`);
  });
}

async function waitForApisix(
  adminUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  exited: () => number,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    const code = exited();
    if (code !== 0) throw new Error(`docker compose 已退出 code=${String(code)}`);
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
  const dockerBin = opts.spawnFn ? 'docker' : dockerExecutable();
  const spawnFn: EdgeSpawn = opts.spawnFn ?? ((command, args, options) => {
    const bin = command === 'docker' ? (dockerBin ?? command) : command;
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, args, { ...options, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    attachOutput(edgeProcName(bin), child);
    return child;
  });
  const extractFn = opts.extractFn ?? extractArchive;
  const children: EdgeChild[] = [];
  const noopEdge: GatewayEdge = {
    stop() {},
    async applyTaskHost() {},
    async syncTaskHosts() {},
  };
  let edgeApi: Omit<GatewayEdge, 'stop'> = noopEdge;
  let composeFile = '';

  const stop = () => {
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 进程已退出
      }
    }
    if (!composeFile || (!opts.spawnFn && !dockerBin)) return;
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
    if (!opts.spawnFn && !dockerBin) {
      console.error('[edge] 未找到 docker，跳过 APISIX。登录 shell 的 which docker 若是 /usr/bin/docker，确认该文件存在后重启网关。');
    } else if (dockerBin && dockerBin !== 'docker') {
      console.log(`[edge] APISIX 使用 ${dockerBin}`);
    }
    if (opts.spawnFn || dockerBin) {
      const apisixChild = spawnFn('docker', apisixComposeArgs(composeFile, 'up'), { windowsHide: true, stdio: 'ignore' });
      let composeExit = 0;
      watchChild('apisix', apisixChild, (code) => {
        composeExit = code;
      });
      children.push(apisixChild);
      if (!opts.spawnFn || opts.adminFetch) {
        await waitForApisix(adminUrl, adminKey, adminFetch, () => composeExit);
      }
      console.log(`[edge] APISIX 已在 ${NGINX_LISTEN_HOST}:${NGINX_LISTEN_PORT} 监听，管理接口 ${adminUrl}`);
    }
  } catch (err) {
    console.error(`[edge] 安装或启动失败：${err instanceof Error ? err.message : String(err)}`);
    edgeApi = noopEdge;
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
