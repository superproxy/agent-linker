import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultSharedConfig, type SharedConfig } from '@linkagent/shared';
import { getLayout } from '../../install/layout.js';
import { loadEffectiveSharedConfig } from '../store/runtime/index.js';
import { resolveConfigPaths } from './paths.js';
import { loadYamlSharedConfig } from './yaml.js';

export interface LoadedSharedConfig {
  config: SharedConfig;
  source: 'file' | 'defaults';
  path: string;
  mode: 'split' | 'defaults';
}

/**
 * 三进程共享配置加载（优先级）：
 * 1. GATEWAY_CONFIG_PATH 指向的 yaml（缺失则报错）
 * 2. 配置目录：存在 gateway.yaml → 读 gateway/weixin/node 三文件
 * 3. 均缺失 → 内置默认 + 运行时 overlay
 */
export function loadSharedConfig(pathArg?: string, runtimeGatewayDir?: string): LoadedSharedConfig {
  const rtDir = runtimeGatewayDir ?? getLayout().state('gateway');
  const envPath = process.env.GATEWAY_CONFIG_PATH;

  if (envPath) {
    const p = resolve(envPath);
    if (!existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
    const paths = resolveConfigPaths(p);
    const yamlOnly = loadYamlSharedConfig(paths);
    return {
      config: loadEffectiveSharedConfig(yamlOnly, rtDir),
      source: 'file',
      path: paths.primaryPath,
      mode: paths.mode,
    };
  }

  const paths = pathArg ? resolveConfigPaths(pathArg) : resolveConfigPaths();
  const hasYaml =
    paths.mode === 'split' &&
    (existsSync(paths.gatewayFile) || existsSync(paths.weixinFile) || existsSync(paths.nodeFile));

  if (hasYaml) {
    const yamlOnly = loadYamlSharedConfig(paths);
    return {
      config: loadEffectiveSharedConfig(yamlOnly, rtDir),
      source: 'file',
      path: paths.primaryPath,
      mode: 'split',
    };
  }

  if (pathArg) {
    const yamlOnly = defaultSharedConfig();
    return {
      config: loadEffectiveSharedConfig(yamlOnly, rtDir),
      source: 'defaults',
      path: paths.primaryPath,
      mode: 'defaults',
    };
  }

  const yamlOnly = defaultSharedConfig();
  return {
    config: loadEffectiveSharedConfig(yamlOnly, rtDir),
    source: 'defaults',
    path: paths.primaryPath,
    mode: 'defaults',
  };
}
