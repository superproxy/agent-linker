import { createServer } from 'node:net';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 落盘在 .runtime-state/gateway/listen-port.json，供 pm 健康检查读取 */
export const GATEWAY_LISTEN_PORT_FILE = 'listen-port.json';

export interface GatewayListenPortRecord {
  port: number;
  configuredPort: number;
  pid: number;
  at: number;
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 配置端口可用则沿用；否则在区间内随机尝试直至找到空闲端口 */
export async function resolveGatewayListenPort(host: string, preferred: number): Promise<number> {
  const forced = process.env.LINKAGENT_GATEWAY_PORT?.trim();
  if (forced) {
    const n = Number(forced);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`LINKAGENT_GATEWAY_PORT 无效：${forced}`);
    }
    if (!(await probePort(host, n))) {
      throw new Error(`LINKAGENT_GATEWAY_PORT=${n} 已被占用`);
    }
    return n;
  }

  if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535) {
    if (await probePort(host, preferred)) return preferred;
  }

  const strict = ['1', 'true', 'yes'].includes((process.env.LINKAGENT_GATEWAY_PORT_STRICT ?? '').trim().toLowerCase());
  if (strict) {
    throw new Error(`网关端口 ${preferred} 已被占用（LINKAGENT_GATEWAY_PORT_STRICT=1 时不自动换端口）`);
  }

  const min = Math.max(1024, preferred > 0 ? preferred : 8787);
  const max = Math.min(65535, min + 4096);
  for (let attempt = 0; attempt < 48; attempt++) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    if (candidate === preferred) continue;
    if (await probePort(host, candidate)) return candidate;
  }
  throw new Error(`无法在 ${min}-${max} 内找到可用端口（配置端口 ${preferred} 已占用）`);
}

export function persistGatewayListenPort(
  gatewayRuntimeDir: string,
  record: GatewayListenPortRecord,
): void {
  mkdirSync(gatewayRuntimeDir, { recursive: true });
  writeFileSync(join(gatewayRuntimeDir, GATEWAY_LISTEN_PORT_FILE), `${JSON.stringify(record)}\n`, 'utf8');
}

export function readGatewayListenPort(gatewayRuntimeDir: string): GatewayListenPortRecord | null {
  const file = join(gatewayRuntimeDir, GATEWAY_LISTEN_PORT_FILE);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as GatewayListenPortRecord;
    if (
      !raw ||
      typeof raw.port !== 'number' ||
      typeof raw.configuredPort !== 'number' ||
      typeof raw.pid !== 'number'
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function clearGatewayListenPort(gatewayRuntimeDir: string): void {
  const file = join(gatewayRuntimeDir, GATEWAY_LISTEN_PORT_FILE);
  try {
    unlinkSync(file);
  } catch {
    /* 不存在则忽略 */
  }
}

/** pm 健康检查：若落盘 pid 与当前 gateway pid 一致则用实际端口 */
export function effectiveGatewayPort(
  gatewayRuntimeDir: string,
  configuredPort: number,
  gatewayPid: number | null,
): number {
  const rec = readGatewayListenPort(gatewayRuntimeDir);
  if (rec && gatewayPid !== null && rec.pid === gatewayPid && rec.port >= 1 && rec.port <= 65535) {
    return rec.port;
  }
  return configuredPort;
}
