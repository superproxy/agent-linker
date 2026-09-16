import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument } from 'yaml';
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

/**
 * 持久化「默认任务绑定的 agent」到 gateway.yaml 的 tasks.defaultAgentId（重启保留）。
 * - 用 YAML Document API 就地改值，最大程度保留原有注释 / 键序 / 格式；
 * - 文件不存在（此前纯默认配置运行）则新建最小 tasks 段；
 * - tasks 段缺失时补齐为 { defaultAgentId }；
 * 写回后重新解析校验，确保落盘内容仍是合法网关配置。
 * 返回写入的绝对路径。
 */
export function persistDefaultTaskAgentId(path: string, agentId: string): string {
  const p = resolve(path);
  const id = agentId.trim();
  if (!id) throw new Error('defaultAgentId 不能为空');

  let doc = parseDocument('');
  if (existsSync(p)) {
    doc = parseDocument(readFileSync(p, 'utf8'));
  } else {
    mkdirSync(dirname(p), { recursive: true });
  }

  const tasks = doc.get('tasks') as { set?: (key: string, value: unknown) => void } | null;
  if (tasks && typeof tasks.set === 'function') {
    tasks.set('defaultAgentId', id);
  } else {
    doc.set('tasks', { defaultAgentId: id });
  }

  writeFileSync(p, doc.toString(), 'utf8');

  const reparsed = gatewayConfigSchema.parse(parse(readFileSync(p, 'utf8')));
  if (reparsed.tasks.defaultAgentId !== id) {
    throw new Error(`持久化校验失败：tasks.defaultAgentId 未更新为 ${id}`);
  }
  return p;
}
