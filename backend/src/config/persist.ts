import { resolve } from 'node:path';
import type { AgentDefinition, SharedConfig } from '@linkagent/shared';
import { nodeAgentEntryId, normalizeAgentId } from '@linkagent/shared';
import { getLayout } from '../install/layout.js';
import {
  applyRuntimeOverlay,
  createGatewayRuntimeRepository,
  type GatewayRuntimeRepository,
} from '../gateway/store/runtime/index.js';
import { yamlBaseFromPath } from './yaml.js';
import { resolveConfigPaths } from './paths.js';
import { persistWeixinChannelGatewaySetup } from './persist-weixin.js';

const WEIXIN_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;

function runtimeGatewayDirArg(explicit?: string): string {
  return explicit ?? getLayout().state('gateway');
}

function persistViaRuntime(
  configPath: string,
  runtimeGatewayDir: string | undefined,
  mutate: (store: GatewayRuntimeRepository, base: SharedConfig) => void,
): SharedConfig {
  const rtDir = runtimeGatewayDirArg(runtimeGatewayDir);
  const base = yamlBaseFromPath(configPath);
  const store = createGatewayRuntimeRepository(rtDir);
  store.ensureBootstrapped(base);
  mutate(store, base);
  return applyRuntimeOverlay(base, store.loadOverlay());
}

/**
 * 持久化「默认任务绑定的 agent」到运行时 KV（不写 config.yaml）。
 * 返回 config 文件路径（兼容旧调用方）。
 */
export function persistDefaultTaskAgentId(path: string, agentId: string, runtimeGatewayDir?: string): string {
  const id = agentId.trim();
  if (!id) throw new Error('defaultAgentId 不能为空');
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store) => {
    store.setDefaultTaskAgentId(id);
  });
  if (effective.gateway.tasks.defaultAgentId !== id) {
    throw new Error(`持久化校验失败：tasks.defaultAgentId 未更新为 ${id}`);
  }
  return resolve(path);
}

/** 本机 agent 启停写入运行时 KV（不写 config.yaml）。 */
export function persistAgentEnabled(
  path: string,
  agentId: string,
  enabled: boolean,
  defs: AgentDefinition[],
  runtimeGatewayDir?: string,
): AgentDefinition[] {
  const id = agentId.trim();
  if (!id) throw new Error('agentId 不能为空');
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store, base) => {
    store.setAgentEnabled(id, enabled, defs, base.gateway.agents.map((a) => a.id));
  });
  const hit = effective.gateway.agents.find((a) => a.id === id);
  if (!hit) throw new Error(`持久化校验失败：gateway.agents 未包含 ${id}`);
  const nowOn = hit.enabled !== false;
  if (nowOn !== enabled) {
    throw new Error(`持久化校验失败：${id}.enabled 未更新为 ${enabled}`);
  }
  return [...effective.gateway.agents];
}

/** 登记 node 自报 agent id 到运行时 KV（不写 config.yaml）。 */
export function persistNodeAgentRegistered(path: string, agentId: string, runtimeGatewayDir?: string): string[] {
  const id = normalizeAgentId(agentId);
  if (!id) throw new Error('agentId 不能为空');
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store) => {
    store.registerNodeAgent(id);
  });
  if (!effective.node.agents.map(nodeAgentEntryId).includes(id)) {
    throw new Error(`持久化校验失败：node.agents 未包含 ${id}`);
  }
  return effective.node.agents.map(nodeAgentEntryId);
}

/** 微信绑定账号写入运行时 KV（不写 config.yaml）。 */
export function persistEnsureWeixinAccount(path: string, accountId: string, runtimeGatewayDir?: string): string[] {
  const id = accountId.trim();
  if (!WEIXIN_ACCOUNT_ID_RE.test(id)) throw new Error(`非法微信账号 id: ${accountId}`);
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store) => {
    store.ensureWeixinAccount(id);
  });
  if (!effective.weixin.accounts.includes(id)) {
    throw new Error(`持久化校验失败：weixin.accounts 未包含 ${id}`);
  }
  const mode = effective.weixin.mode;
  if (mode !== 'external' && mode !== 'weixin-bot' && mode !== 'openclaw-weixin-plugin') {
    throw new Error(`持久化校验失败：weixin.mode 非法 ${mode}`);
  }
  if (effective.weixin.enabled !== true) {
    throw new Error('持久化校验失败：weixin.enabled 未打开');
  }
  if (resolveConfigPaths(path).mode === 'split') {
    persistWeixinChannelGatewaySetup(path, {
      enabled: true,
      weixin: true,
      weixinPlugin: mode === 'openclaw-weixin-plugin',
    });
  }
  return [...effective.weixin.accounts];
}

/** 已有 overlay 账号但 channels.yaml 未开时，补齐 channel-gateway（启动/ pm all 用）。 */
export function persistEnsureWeixinChannelGateway(path: string, mode: string): void {
  if (resolveConfigPaths(path).mode !== 'split') return;
  const plugin = mode === 'openclaw-weixin-plugin';
  persistWeixinChannelGatewaySetup(path, {
    enabled: true,
    weixin: true,
    weixinPlugin: plugin,
  });
}

/** 从运行时 KV 的 weixin.accounts 去掉账号 id。 */
export function persistRemoveWeixinAccount(path: string, accountId: string, runtimeGatewayDir?: string): string[] {
  const id = accountId.trim();
  if (!WEIXIN_ACCOUNT_ID_RE.test(id)) return [];
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store) => {
    store.removeWeixinAccount(id);
  });
  return [...effective.weixin.accounts];
}

/** 可改挂载网关的子进程段（weixin / node 进程，配置里均为顶层同名段） */
export type ChildSectionId = 'weixin' | 'node';

export interface ChildGatewayTarget {
  /** 远程网关 base；空串表示切回本机网关（清空该段回连地址，恢复缺省推导） */
  url: string;
  /** 回连凭据；切回本机或远程网关免鉴权时留空 */
  token: string;
}

/** 微信 / node 子进程回连网关地址写入运行时 KV（不写 config.yaml）。 */
export function persistChildGatewayTarget(
  path: string,
  section: ChildSectionId,
  target: ChildGatewayTarget,
  runtimeGatewayDir?: string,
): string {
  const url = target.url.trim().replace(/\/+$/, '');
  const token = target.token.trim();
  if (url && !/^https?:\/\/\S+$/.test(url)) {
    throw new Error('网关地址需以 http:// 或 https:// 开头');
  }
  const effective = persistViaRuntime(path, runtimeGatewayDir, (store) => {
    store.setChildGateway(section, url, token);
  });
  const gotUrl = effective[section].gatewayUrl;
  if ((url || '') !== gotUrl) {
    throw new Error(`持久化校验失败：${section}.gatewayUrl 未更新为 ${url || '（本机）'}`);
  }
  return resolve(path);
}
