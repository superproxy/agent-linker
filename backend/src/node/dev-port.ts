import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAAS_DEV_LISTEN } from './saas-path.js';

/** 聚合容器内：由 entrypoint 或 dockerDevProcess 占 5173。 */
export function nodeRunsInsideIdeContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  const frpc = (process.env.LINKAGENT_FRPC_PATH ?? '').replace(/\\/g, '/');
  return frpc.includes('/etc/linkagent');
}

export interface DevPortState {
  taskId: string;
  port: number;
  listen: '127.0.0.1';
  /** frpc 仍登记 workspace-dev → 本机适配器口，适配器再转发到 port */
  adapterPort: typeof SAAS_DEV_LISTEN;
  updatedAt: number;
}

export function devPortStatePath(runtimeDir: string): string {
  return join(runtimeDir, 'dev-port.json');
}

/** 本机空闲 TCP 口，供 Vite dev 使用（避免 5173 被占导致 strictPort 失败）。 */
export function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('无法分配端口'));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export function writeDevPortState(runtimeDir: string, state: DevPortState): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(devPortStatePath(runtimeDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function readDevPortState(runtimeDir: string): DevPortState | null {
  try {
    const raw = readFileSync(devPortStatePath(runtimeDir), 'utf8');
    const parsed = JSON.parse(raw) as DevPortState;
    if (!parsed.taskId?.trim() || !Number.isInteger(parsed.port) || parsed.port <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
