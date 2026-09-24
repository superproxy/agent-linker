import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  assembleSharedConfig,
  defaultSharedConfig,
  migrateConfig,
  normalizeSectionDocument,
  type SharedConfig,
} from '@linkagent/shared';
import { resolveConfigPaths, type ResolvedConfigPaths } from './paths.js';

function readYamlFile(path: string): unknown {
  return parse(readFileSync(path, 'utf8'));
}

function loadSplitYaml(paths: ResolvedConfigPaths): SharedConfig {
  const gatewayRaw = existsSync(paths.gatewayFile) ? readYamlFile(paths.gatewayFile) : undefined;
  const weixinRaw = existsSync(paths.weixinFile) ? readYamlFile(paths.weixinFile) : undefined;
  const channelsRaw = existsSync(paths.channelsFile) ? readYamlFile(paths.channelsFile) : undefined;
  const nodeRaw = existsSync(paths.nodeFile) ? readYamlFile(paths.nodeFile) : undefined;
  return assembleSharedConfig({
    gateway: gatewayRaw !== undefined ? normalizeSectionDocument(gatewayRaw, 'gateway') : undefined,
    weixin: weixinRaw !== undefined ? normalizeSectionDocument(weixinRaw, 'weixin') : undefined,
    channelGateway: channelsRaw !== undefined ? normalizeSectionDocument(channelsRaw, 'channelGateway') : undefined,
    node: nodeRaw !== undefined ? normalizeSectionDocument(nodeRaw, 'node') : undefined,
  });
}

/**
 * 读取 yaml 底稿（不含运行时 overlay）。
 * split：同目录 gateway/weixin/channels/node。
 * 其它已存在的单文件（如测试 fixture gateway.auth.yaml）：按旧扁平格式 migrateConfig。
 * 文件不存在：内置默认。
 */
export function loadYamlSharedConfig(paths: ResolvedConfigPaths): SharedConfig {
  if (paths.mode === 'split') return loadSplitYaml(paths);
  if (existsSync(paths.primaryPath)) {
    return migrateConfig(readYamlFile(paths.primaryPath));
  }
  return defaultSharedConfig();
}

/** @deprecated 单文件加载；新代码请用 {@link loadYamlSharedConfig} */
export function parseSharedYamlFile(p: string): SharedConfig {
  return loadYamlSharedConfig(resolveConfigPaths(p));
}

/** 读取 yaml 底稿；path 可为 gateway.yaml、config.yaml 或配置目录 */
export function yamlBaseFromPath(path: string): SharedConfig {
  return loadYamlSharedConfig(resolveConfigPaths(path));
}
