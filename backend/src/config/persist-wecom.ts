import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { normalizeSectionDocument } from '@linkagent/shared';
import { resolveConfigPaths } from './paths.js';
import { yamlBaseFromPath } from './yaml.js';

export const DEFAULT_WECOM_PLUGIN = '@wecom/wecom-openclaw-plugin';

/** 智能机器人 Bot：websocket=官方长连接（应用内授权）；webhook=HTTP 回调 */
export type WecomConnectionMode = 'websocket' | 'webhook';

export interface WecomChannelPersistInput {
  enabled: boolean;
  botId: string;
  /** 空串表示不更新已有 secret */
  secret: string;
  connectionMode: WecomConnectionMode;
  pluginPackage?: string;
}

export interface ChannelGatewayWecomPersistInput {
  enabled: boolean;
  wecom: boolean;
  model?: string;
  serverHost?: string;
  serverPort?: number;
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

function wecomFromConfig(base: ReturnType<typeof yamlBaseFromPath>): Record<string, unknown> {
  const fromCg = base.channelGateway.channels.wecom;
  if (fromCg && typeof fromCg === 'object' && !Array.isArray(fromCg)) {
    return { ...(fromCg as Record<string, unknown>) };
  }
  const legacy = base.gateway.channels.wecom;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    return { ...(legacy as Record<string, unknown>) };
  }
  return {};
}

function pluginPackageFromConfig(base: ReturnType<typeof yamlBaseFromPath>): string {
  const cgPlugins = base.channelGateway.plugins ?? [];
  const hit = cgPlugins.find((p) => p.package.includes('wecom'));
  if (hit) return hit.package;
  const gwHit = (base.gateway.plugins ?? []).find((p) => p.package.includes('wecom'));
  return gwHit?.package ?? DEFAULT_WECOM_PLUGIN;
}

/** 仅写入 channels.yaml（channelGateway.channels.wecom + plugins）；不修改 gateway.yaml。 */
export function persistWecomChannelSetup(
  configPath: string,
  wecom: WecomChannelPersistInput,
  cg: ChannelGatewayWecomPersistInput,
): { channelsFile: string } {
  const paths = resolveConfigPaths(configPath);
  if (paths.mode !== 'split') {
    throw new Error('企业微信后台配置需 split 配置（channels.yaml），请使用标准安装目录');
  }

  const botId = wecom.botId.trim();
  if (wecom.enabled && !botId) {
    throw new Error('启用企微时需填写 botId');
  }

  const pluginPackage = (wecom.pluginPackage ?? DEFAULT_WECOM_PLUGIN).trim() || DEFAULT_WECOM_PLUGIN;

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
  const prevWecom =
    prevChannels.wecom && typeof prevChannels.wecom === 'object' && !Array.isArray(prevChannels.wecom)
      ? { ...(prevChannels.wecom as Record<string, unknown>) }
      : wecomFromConfig(yamlBaseFromPath(paths.primaryPath));

  const nextWecom: Record<string, unknown> = {
    ...prevWecom,
    enabled: wecom.enabled,
    connectionMode: wecom.connectionMode,
    botId,
  };
  const secretIn = wecom.secret.trim();
  if (secretIn) {
    nextWecom.secret = secretIn;
  } else if (wecom.enabled && typeof prevWecom.secret !== 'string') {
    throw new Error('启用企微时需填写 secret（或 yaml 中已有 secret）');
  }

  const prevServer =
    prevInner.server && typeof prevInner.server === 'object' && !Array.isArray(prevInner.server)
      ? { ...(prevInner.server as Record<string, unknown>) }
      : {};

  const server: Record<string, unknown> = { ...prevServer };
  if (cg.serverHost?.trim()) server.host = cg.serverHost.trim();
  if (cg.serverPort !== undefined && Number.isFinite(cg.serverPort)) server.port = cg.serverPort;

  const nextCg: Record<string, unknown> = {
    ...prevInner,
    enabled: cg.enabled,
    wecom: cg.wecom,
    server,
    channels: { ...prevChannels, wecom: nextWecom },
    plugins: ensurePluginEntry(prevInner.plugins, pluginPackage, wecom.enabled),
  };
  if (cg.model?.trim()) nextCg.model = cg.model.trim();

  writeYamlObject(paths.channelsFile, { channelGateway: nextCg });

  const effective = yamlBaseFromPath(paths.primaryPath);
  if (wecom.enabled && cg.enabled) {
    const w = effective.channelGateway.channels.wecom;
    if (!w || typeof w !== 'object') {
      throw new Error('持久化校验失败：channelGateway.channels.wecom 未写入');
    }
    const rec = w as Record<string, unknown>;
    if (rec.botId !== botId) {
      throw new Error('持久化校验失败：botId 不一致');
    }
  }
  if (cg.enabled !== effective.channelGateway.enabled) {
    throw new Error('持久化校验失败：channelGateway.enabled 未更新');
  }

  return { channelsFile: resolve(paths.channelsFile) };
}

export function readWecomConfigView(configPath: string): {
  wecom: Record<string, unknown>;
  channelGateway: ReturnType<typeof yamlBaseFromPath>['channelGateway'];
  pluginPackage: string;
} {
  const paths = resolveConfigPaths(configPath);
  const base = yamlBaseFromPath(paths.primaryPath);
  return {
    wecom: wecomFromConfig(base),
    channelGateway: base.channelGateway,
    pluginPackage: pluginPackageFromConfig(base),
  };
}

export function maskSecret(secret: unknown): { configured: boolean; preview: string } {
  if (typeof secret !== 'string' || !secret.trim()) {
    return { configured: false, preview: '' };
  }
  const s = secret.trim();
  if (s.length <= 4) return { configured: true, preview: '****' };
  return { configured: true, preview: `${s.slice(0, 2)}…${s.slice(-2)}` };
}
