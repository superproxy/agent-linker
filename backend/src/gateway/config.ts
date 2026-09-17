import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { gatewayConfigSchema, defaultConfig, type GatewayConfig } from '@linkagent/shared';
import { findInstallRoot, findRepoRoot, getLayout } from '../install/layout.js';

// 根目录定位统一收敛到 install/layout；此处 re-export 以兼容既有 import 路径。
export { findInstallRoot, findRepoRoot };

/** 配置路径：形态优先（dist→server/config，dev→backend/config），由 layout 统一解析 */
const defaultConfigPath = () => getLayout().configFile;

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
