import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { AuthMode, SharedConfig } from '@linkagent/shared';
import { getLayout } from '../../install/layout.js';

/** 生成一枚随机永久 token（不写入 yaml，落盘 .runtime-state/gateway-token） */
export function generateGatewayToken(): string {
  return `lg_${randomBytes(24).toString('base64url')}`;
}

/**
 * 读取持久化的 gateway token；文件不存在时自动生成、落盘（0600）并返回。
 * 三进程共享同一文件：首个启动的（通常 gateway）负责生成，其余读取复用。
 */
export function ensureGatewayTokenFile(file?: string): string {
  const p = file ?? getLayout().gatewayTokenFile;
  if (existsSync(p)) {
    const existing = readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  }
  const token = generateGatewayToken();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 等不支持 chmod 时忽略 */
  }
  return token;
}

/** 只读持久化 token；不存在返回空串（不生成，供非 gateway 进程使用） */
export function readGatewayTokenFile(file?: string): string {
  const p = file ?? getLayout().gatewayTokenFile;
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

export interface ResolvedGatewayAuth {
  mode: AuthMode;
  /** 生效中的永久 gateway token（配置优先，否则取/建 token 文件） */
  token: string;
  sessionTtlDays: number;
}

/**
 * 解析 gateway 进程实际使用的鉴权参数：
 * - open：不鉴权，token 置空；
 * - local/token：auth.token 配置优先；留空则读（gateway 进程）/建 token 文件。
 */
export function resolveGatewayAuth(config: SharedConfig, tokenFile?: string): ResolvedGatewayAuth {
  const auth = config.gateway.auth;
  if (auth.mode === 'open') return { mode: 'open', token: '', sessionTtlDays: auth.sessionTtlDays };
  const configured = auth.token.trim();
  const token = configured || ensureGatewayTokenFile(tokenFile);
  return { mode: auth.mode, token, sessionTtlDays: auth.sessionTtlDays };
}
