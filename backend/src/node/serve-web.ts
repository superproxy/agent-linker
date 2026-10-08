import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { NodeSection } from '@linkagent/shared';

export type ServeWebConfig = NodeSection['serveWeb'];

export interface ServeWebLaunch {
  serveWeb: ServeWebConfig;
  /** 挂进 IDE 容器的目录 */
  workspaceDir: string;
  /** compose 落盘目录 */
  runtimeDir: string;
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
 * 浏览器经 8088 访问时带端口。APISIX 的 X-Forwarded-Host 不含端口，
 * code-server 会判定来源不一致并拒绝工作台 WebSocket。
 */
const IDE_TRUSTED_ORIGIN = '*.localhost:8088';

function dockerVolumeHost(workspaceDir: string): string {
  return workspaceDir.replace(/\\/g, '/');
}

export function serveWebBasePath(basePath: string): string {
  const withSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withSlash.replace(/\/+$/, '') || '/vibe-ide';
}

/** node 只发布 code-server。nginx 由网关安装，反代这个回环端口。 */
export function renderIdeCompose(opts: ServeWebConfig, workspaceDir: string): string {
  const prefix = serveWebBasePath(opts.basePath);
  const doc = {
    services: {
      'code-serve-web': {
        image: opts.image,
        container_name: CODE_CONTAINER,
        restart: 'unless-stopped',
        user: '0:0',
        command: [
          '--auth', 'none',
          '--bind-addr', '0.0.0.0:8080',
          '--abs-proxy-base-path', prefix,
          '--trusted-origins', IDE_TRUSTED_ORIGIN,
          IDE_CONTAINER_WORKSPACE,
        ],
        ports: [`${opts.host}:${opts.port}:8080`],
        volumes: [`${dockerVolumeHost(workspaceDir)}:${IDE_CONTAINER_WORKSPACE}`],
      },
    },
  };
  return stringify(doc);
}

export function serveWebDockerArgs(composeFile: string, action: 'up' | 'down'): string[] {
  return action === 'up' ? ['compose', '-f', composeFile, 'up', '-d'] : ['compose', '-f', composeFile, 'down'];
}

/** node 启动时只拉起 code-server。未启用或 docker 不存在时不打断节点回连。 */
export function startNodeServeWeb(launch: ServeWebLaunch, spawnFn: ServeWebSpawn = spawn as ServeWebSpawn): { stop: () => void } {
  const { serveWeb } = launch;
  if (!serveWeb.enabled) return { stop() {} };
  mkdirSync(launch.runtimeDir, { recursive: true });
  const composeFile = join(launch.runtimeDir, 'compose.yml');
  writeFileSync(composeFile, renderIdeCompose(serveWeb, launch.workspaceDir), 'utf8');

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
