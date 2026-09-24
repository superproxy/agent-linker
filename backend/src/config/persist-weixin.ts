import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { normalizeSectionDocument } from '@linkagent/shared';
import { resolveConfigPaths } from './paths.js';
import { yamlBaseFromPath } from './yaml.js';

export const DEFAULT_WEIXIN_PLUGIN = '@tencent-weixin/openclaw-weixin';

export interface ChannelGatewayWeixinPersistInput {
  /** 启用 channel-gateway 进程 */
  enabled: boolean;
  /** channels 内托管个人微信 */
  weixin: boolean;
  /** 使用 OpenClaw 插件收发（否则 weixin-bot） */
  weixinPlugin: boolean;
  model?: string;
}

function readYamlObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

function writeYamlObject(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stringify(doc)}\n`, 'utf8');
}

function ensurePluginEntry(
  plugins: unknown,
  packageName: string,
  enabled: boolean,
): Array<{ package: string; enabled?: boolean }> {
  const list = Array.isArray(plugins)
    ? plugins
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
        .map((p) => ({
          package: String(p.package ?? ''),
          ...(p.enabled === false ? { enabled: false as const } : {}),
        }))
        .filter((p) => p.package)
    : [];
  const hit = list.find((p) => p.package === packageName);
  if (!hit) {
    list.push({ package: packageName, ...(enabled ? {} : { enabled: false }) });
  } else if (enabled && hit.enabled === false) {
    hit.enabled = undefined;
  }
  return list;
}

function openclawWeixinChannelFromGateway(base: ReturnType<typeof yamlBaseFromPath>): Record<string, unknown> | undefined {
  const ch = base.gateway.channels['openclaw-weixin'];
  if (ch && typeof ch === 'object' && !Array.isArray(ch)) {
    return { ...(ch as Record<string, unknown>) };
  }
  return undefined;
}

/** 仅写入 channels.yaml（channelGateway.weixin / weixinPlugin + plugins）；不修改 gateway.yaml。 */
export function persistWeixinChannelGatewaySetup(
  configPath: string,
  cg: ChannelGatewayWeixinPersistInput,
  pluginPackage = DEFAULT_WEIXIN_PLUGIN,
): { channelsFile: string } {
  const paths = resolveConfigPaths(configPath);
  if (paths.mode !== 'split') {
    throw new Error('个人微信 channel-gateway 配置需 split 配置（channels.yaml）');
  }

  const pkg = pluginPackage.trim() || DEFAULT_WEIXIN_PLUGIN;
  const channelsDoc = readYamlObject(paths.channelsFile);
  const prevCg = normalizeSectionDocument(channelsDoc, 'channelGateway');
  const prevInner =
    prevCg && typeof prevCg === 'object' && !Array.isArray(prevCg)
      ? { ...(prevCg as Record<string, unknown>) }
      : {};

  const prevChannels =
    prevInner.channels && typeof prevInner.channels === 'object' && !Array.isArray(prevInner.channels)
      ? { ...(prevInner.channels as Record<string, unknown>) }
      : {};

  const base = yamlBaseFromPath(paths.primaryPath);
  const openclawCh = openclawWeixinChannelFromGateway(base);
  const nextChannels = { ...prevChannels };
  if (cg.weixinPlugin && openclawCh && !nextChannels['openclaw-weixin']) {
    nextChannels['openclaw-weixin'] = openclawCh;
  }

  const pluginOn = cg.weixin && cg.weixinPlugin;
  const nextCg: Record<string, unknown> = {
    ...prevInner,
    enabled: cg.enabled,
    weixin: cg.weixin,
    weixinPlugin: cg.weixinPlugin,
    channels: nextChannels,
    plugins: ensurePluginEntry(prevInner.plugins, pkg, pluginOn),
  };
  if (cg.model?.trim()) nextCg.model = cg.model.trim();

  writeYamlObject(paths.channelsFile, { channelGateway: nextCg });

  const effective = yamlBaseFromPath(paths.primaryPath);
  if (cg.enabled !== effective.channelGateway.enabled) {
    throw new Error('持久化校验失败：channelGateway.enabled 未更新');
  }
  if (cg.weixinPlugin !== effective.channelGateway.weixinPlugin) {
    throw new Error('持久化校验失败：weixinPlugin 未更新');
  }

  return { channelsFile: resolve(paths.channelsFile) };
}

export function readWeixinChannelGatewayView(configPath: string): {
  channelGateway: ReturnType<typeof yamlBaseFromPath>['channelGateway'];
} {
  const base = yamlBaseFromPath(configPath);
  return {
    channelGateway: base.channelGateway,
  };
}
