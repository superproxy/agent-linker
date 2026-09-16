import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * 定位「安装根」：独立部署产物（dist/linkagent）或仓库根（开发模式）。
 * 优先级：
 * 1. 环境变量 LINKAGENT_HOME（显式指定安装目录）
 * 2. 从本模块文件位置向上找部署 marker `.linkagent-root`（产物布局：<root>/server/index.mjs）
 * 3. 回退 monorepo 根（开发模式，含 pnpm-workspace.yaml）
 *
 * 产物内所有运行态目录（.runtime-state/、web/、config/）都相对此根解析，
 * 因此 dist 目录可整体拷贝到任意机器运行。
 */
export function findInstallRoot(): string {
  const env = process.env.LINKAGENT_HOME;
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.linkagent-root'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return findRepoRoot();
}

/** 配置路径：独立部署（<root>/server/config/gateway.yaml）与开发模式（<root>/backend/config/gateway.yaml）兼容 */
const defaultConfigPath = () => {
  const root = findInstallRoot();
  for (const p of [join(root, 'server', 'config', 'gateway.yaml'), join(root, 'backend', 'config', 'gateway.yaml')]) {
    if (existsSync(p)) return p;
  }
  return join(root, 'server', 'config', 'gateway.yaml');
};

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
