import { migrateConfig, type SharedConfig } from './config.js';

export const CONFIG_BASENAMES = {
  gateway: 'gateway.yaml',
  weixin: 'weixin.yaml',
  channels: 'channels.yaml',
  node: 'node.yaml',
  monolith: 'config.yaml',
} as const;

export type ConfigSectionId = 'gateway' | 'weixin' | 'channelGateway' | 'node';

/** 单段 yaml 文档：可为 `gateway: {...}` 或直接写段内字段 */
/** channels.yaml 文件内段名 channelGateway；兼容顶层 channelGateway: 或直接写字段 */
export function normalizeSectionDocument(raw: unknown, section: ConfigSectionId): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  if (section in o) return o[section];
  if (section === 'channelGateway' && 'channels' in o) return o.channels;
  return o;
}

/** 将三段原始对象合并为 {@link SharedConfig}（缺段走 schema 默认） */
export function assembleSharedConfig(parts: Partial<Record<ConfigSectionId, unknown>>): SharedConfig {
  const payload: Record<string, unknown> = {
    channelGateway: parts.channelGateway ?? {},
  };
  if (parts.gateway !== undefined) payload.gateway = parts.gateway;
  if (parts.weixin !== undefined) payload.weixin = parts.weixin;
  if (parts.node !== undefined) payload.node = parts.node;
  return migrateConfig(payload);
}
