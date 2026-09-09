import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { gatewayConfigSchema, defaultConfig, type GatewayConfig } from '@linkagent/shared';

/** 从任一子目录向上定位 monorepo 根（含 pnpm-workspace.yaml） */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

const defaultConfigPath = () => join(findRepoRoot(), 'backend', 'config', 'gateway.yaml');

export interface LoadedConfig {
  config: GatewayConfig;
  source: 'file' | 'defaults';
  path: string;
}

/**
 * 配置来源（优先级）：
 * 1. 环境变量 GATEWAY_CONFIG_PATH 指向的 yaml（缺失则报错）
 * 2. <repo>/backend/config/gateway.yaml（存在则加载；缺失回退默认值）
 */
export function loadGatewayConfig(pathArg?: string): LoadedConfig {
  const explicit = process.env.GATEWAY_CONFIG_PATH || pathArg;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
    return { config: parseConfigFile(p), source: 'file', path: p };
  }
  const p = defaultConfigPath();
  if (existsSync(p)) return { config: parseConfigFile(p), source: 'file', path: p };
  return { config: defaultConfig(), source: 'defaults', path: p };
}

function parseConfigFile(p: string): GatewayConfig {
  const raw = readFileSync(p, 'utf8');
  const doc = parse(raw) as unknown;
  return gatewayConfigSchema.parse(doc);
}
