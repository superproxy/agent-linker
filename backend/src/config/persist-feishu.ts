import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { normalizeSectionDocument } from '@linkagent/shared';
import { resolveConfigPaths } from './paths.js';
import { yamlBaseFromPath } from './yaml.js';
import { maskSecret } from './persist-wecom.js';

export { maskSecret };

export const DEFAULT_FEISHU_PLUGIN = '@openclaw/feishu';

export type FeishuConnectionMode = 'websocket' | 'webhook';

export interface FeishuChannelPersistInput {
  enabled: boolean;
  appId: string;
  /** 空串表示不更新已有 appSecret */
  appSecret: string;
  connectionMode: FeishuConnectionMode;
  pluginPackage?: string;
  verificationToken?: string;
  encryptKey?: string;
}

export interface ChannelGatewayFeishuPersistInput {
  enabled: boolean;
  feishu: boolean;
  feishuPluginPackage?: string;
  /** 飞书消息任务空间归属（复用 channelGateway.wecomOwner 字段） */
  wecomOwner?: string;
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

function feishuFromConfig(base: ReturnType<typeof yamlBaseFromPath>): Record<string, unknown> {
  const fromCg = base.channelGateway.channels.feishu;
  if (fromCg && typeof fromCg === 'object' && !Array.isArray(fromCg)) {
    return { ...(fromCg as Record<string, unknown>) };
  }
  const legacy = base.gateway.channels.feishu;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    return { ...(legacy as Record<string, unknown>) };
  }
  return {};
}

function defaultAccount(feishu: Record<string, unknown>): Record<string, unknown> {
  const accounts = feishu.accounts;
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    const rec = accounts as Record<string, unknown>;
    const def = rec.default;
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      return { ...(def as Record<string, unknown>) };
    }
  }
  return {};
}

function pluginPackageFromConfig(base: ReturnType<typeof yamlBaseFromPath>): string {
  const fromCg = base.channelGateway.feishuPluginPackage?.trim();
  if (fromCg) return fromCg;
  const cgPlugins = base.channelGateway.plugins ?? [];
  const hit = cgPlugins.find((p) => /feishu|lark/i.test(p.package));
  if (hit) return hit.package;
  const gwHit = (base.gateway.plugins ?? []).find((p) => /feishu|lark/i.test(p.package));
  return gwHit?.package ?? DEFAULT_FEISHU_PLUGIN;
}

export function readFeishuCredentials(feishu: Record<string, unknown>): {
  appId: string;
  appSecret: unknown;
} {
  const acc = defaultAccount(feishu);
  const appId =
    (typeof acc.appId === 'string' ? acc.appId : '') ||
    (typeof feishu.appId === 'string' ? feishu.appId : '');
  const appSecret =
    typeof acc.appSecret === 'string'
      ? acc.appSecret
      : typeof feishu.appSecret === 'string'
        ? feishu.appSecret
        : undefined;
  return { appId, appSecret };
}

/** 仅写入 channels.yaml（channelGateway.channels.feishu + plugins）；不修改 gateway.yaml。 */
export function persistFeishuChannelSetup(
  configPath: string,
  feishu: FeishuChannelPersistInput,
  cg: ChannelGatewayFeishuPersistInput,
): { channelsFile: string } {
  const paths = resolveConfigPaths(configPath);
  if (paths.mode !== 'split') {
    throw new Error('飞书后台配置需 split 配置（channels.yaml），请使用标准安装目录');
  }

  const appId = feishu.appId.trim();
  if (feishu.enabled && !appId) {
    throw new Error('启用飞书时需填写 appId');
  }

  const pluginPackage = (feishu.pluginPackage ?? cg.feishuPluginPackage ?? DEFAULT_FEISHU_PLUGIN).trim() || DEFAULT_FEISHU_PLUGIN;

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
  const prevFeishu =
    prevChannels.feishu && typeof prevChannels.feishu === 'object' && !Array.isArray(prevChannels.feishu)
      ? { ...(prevChannels.feishu as Record<string, unknown>) }
      : feishuFromConfig(yamlBaseFromPath(paths.primaryPath));
  const prevAcc = defaultAccount(prevFeishu);

  const nextAcc: Record<string, unknown> = { ...prevAcc, appId };
  const secretIn = feishu.appSecret.trim();
  if (secretIn) {
    nextAcc.appSecret = secretIn;
  } else if (feishu.enabled && typeof prevAcc.appSecret !== 'string' && typeof prevFeishu.appSecret !== 'string') {
    throw new Error('启用飞书时需填写 appSecret（或 yaml 中已有 appSecret）');
  }

  const nextFeishu: Record<string, unknown> = {
    ...prevFeishu,
    enabled: feishu.enabled,
    connectionMode: feishu.connectionMode,
    accounts: { default: nextAcc },
  };
  const vToken = feishu.verificationToken?.trim();
  if (vToken) nextFeishu.verificationToken = vToken;
  const enc = feishu.encryptKey?.trim();
  if (enc) nextFeishu.encryptKey = enc;

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
    feishu: cg.feishu,
    feishuPluginPackage: pluginPackage,
    server,
    channels: { ...prevChannels, feishu: nextFeishu },
    plugins: ensurePluginEntry(prevInner.plugins, pluginPackage, feishu.enabled),
  };
  if (cg.model?.trim()) nextCg.model = cg.model.trim();
  const owner = cg.wecomOwner?.trim();
  if (owner) nextCg.wecomOwner = owner;

  writeYamlObject(paths.channelsFile, { channelGateway: nextCg });

  const effective = yamlBaseFromPath(paths.primaryPath);
  if (feishu.enabled && cg.enabled) {
    const f = effective.channelGateway.channels.feishu;
    if (!f || typeof f !== 'object') {
      throw new Error('持久化校验失败：channelGateway.channels.feishu 未写入');
    }
    const cred = readFeishuCredentials(f as Record<string, unknown>);
    if (cred.appId !== appId) {
      throw new Error('持久化校验失败：appId 不一致');
    }
  }
  if (cg.enabled !== effective.channelGateway.enabled) {
    throw new Error('持久化校验失败：channelGateway.enabled 未更新');
  }
  if (owner && effective.channelGateway.wecomOwner !== owner) {
    throw new Error('持久化校验失败：wecomOwner 未更新');
  }

  return { channelsFile: resolve(paths.channelsFile) };
}

export function readFeishuConfigView(configPath: string): {
  feishu: Record<string, unknown>;
  channelGateway: ReturnType<typeof yamlBaseFromPath>['channelGateway'];
  pluginPackage: string;
} {
  const paths = resolveConfigPaths(configPath);
  const base = yamlBaseFromPath(paths.primaryPath);
  return {
    feishu: feishuFromConfig(base),
    channelGateway: base.channelGateway,
    pluginPackage: pluginPackageFromConfig(base),
  };
}
