import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_BASENAMES } from '@linkagent/shared';
import { getLayout } from '../../install/layout.js';

export type ConfigLoadMode = 'split' | 'monolith' | 'defaults';

export interface ResolvedConfigPaths {
  mode: ConfigLoadMode;
  /** 配置目录（gateway/weixin/node 三文件所在目录） */
  dir: string;
  /** 兼容 persist / API：split 时为 gateway.yaml，monolith 时为 config.yaml */
  primaryPath: string;
  gatewayFile: string;
  weixinFile: string;
  nodeFile: string;
  monolithFile: string;
}

function filesInDir(dir: string): Omit<ResolvedConfigPaths, 'mode'> {
  return {
    dir,
    primaryPath: join(dir, CONFIG_BASENAMES.gateway),
    gatewayFile: join(dir, CONFIG_BASENAMES.gateway),
    weixinFile: join(dir, CONFIG_BASENAMES.weixin),
    nodeFile: join(dir, CONFIG_BASENAMES.node),
    monolithFile: join(dir, CONFIG_BASENAMES.monolith),
  };
}

function modeForDir(dir: string): ConfigLoadMode {
  if (existsSync(join(dir, CONFIG_BASENAMES.gateway))) return 'split';
  if (existsSync(join(dir, CONFIG_BASENAMES.monolith))) return 'monolith';
  return 'defaults';
}

function finalize(dir: string, mode: ConfigLoadMode, primaryOverride?: string): ResolvedConfigPaths {
  const files = filesInDir(dir);
  let primaryPath = files.primaryPath;
  if (mode === 'monolith') primaryPath = files.monolithFile;
  if (primaryOverride) primaryPath = primaryOverride;
  return { mode, ...files, primaryPath };
}

function pathsFromExistingFile(file: string): ResolvedConfigPaths {
  const dir = dirname(file);
  const base = basename(file);
  if (base === CONFIG_BASENAMES.gateway || base === CONFIG_BASENAMES.weixin || base === CONFIG_BASENAMES.node) {
    return finalize(dir, 'split', join(dir, CONFIG_BASENAMES.gateway));
  }
  if (base === CONFIG_BASENAMES.monolith) {
    return finalize(dir, 'monolith', file);
  }
  const mode = modeForDir(dir);
  return finalize(dir, mode, file);
}

/**
 * 解析配置路径：
 * - 未传参：layout.configDir + configMode；
 * - 指向目录：目录内 split 优先于 monolith；
 * - 指向文件：按文件名或同目录探测。
 */
export function resolveConfigPaths(pathArg?: string): ResolvedConfigPaths {
  if (!pathArg) {
    const layout = getLayout();
    const mode: ConfigLoadMode = layout.configMode === 'none' ? 'defaults' : layout.configMode;
    return finalize(layout.configDir, mode, layout.configFile);
  }

  const p = resolve(pathArg);
  if (existsSync(p)) {
    if (statSync(p).isDirectory()) {
      const mode = modeForDir(p);
      return finalize(p, mode);
    }
    return pathsFromExistingFile(p);
  }

  const dir = dirname(p);
  const mode = modeForDir(dir);
  if (mode === 'monolith') return finalize(dir, mode, join(dir, CONFIG_BASENAMES.monolith));
  if (mode === 'split') return finalize(dir, mode, join(dir, CONFIG_BASENAMES.gateway));
  return finalize(dir, 'defaults', p);
}
