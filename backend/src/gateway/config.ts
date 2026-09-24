import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  migrateConfig,
  defaultSharedConfig,
  type AuthMode,
  type SharedConfig,
  // 旧扁平形状（迁移期兼容）
  gatewayConfigSchema,
  defaultConfig,
  type GatewayConfig,
  type AgentDefinition,
  normalizeAgentId,
  nodeAgentEntryId,
} from '@linkagent/shared';
import { findInstallRoot, findRepoRoot, getLayout } from '../install/layout.js';
import {
  applyRuntimeOverlay,
  createRuntimeConfigStore,
  loadEffectiveSharedConfig,
  type RuntimeConfigStore,
} from './store/runtime-config.js';

// 根目录定位统一收敛到 install/layout；此处 re-export 以兼容既有 import 路径。
export { findInstallRoot, findRepoRoot };

/** 配置路径：形态优先（dist→server/config，dev→backend/config），由 layout 统一解析 */
const defaultConfigPath = () => getLayout().configFile;

export interface LoadedSharedConfig {
  config: SharedConfig;
  source: 'file' | 'defaults';
  path: string;
}

/**
 * 三进程共享配置加载（优先级）：
 * 1. 环境变量 GATEWAY_CONFIG_PATH 指向的 yaml（缺失则报错）
 * 2. 形态默认 config/config.yaml（存在则加载；缺失回退三段式默认值）
 * 旧扁平格式经 migrateConfig 自动归一化为 gateway/weixin/node 三段。
 */
export function loadSharedConfig(pathArg?: string, runtimeGatewayDir?: string): LoadedSharedConfig {
  const rtDir = runtimeGatewayDir ?? getLayout().state('gateway');
  const envPath = process.env.GATEWAY_CONFIG_PATH;
  const explicit = envPath || pathArg;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) {
      if (envPath) throw new Error(`配置文件不存在: ${p}`);
      const yamlOnly = defaultSharedConfig();
      return { config: loadEffectiveSharedConfig(yamlOnly, rtDir), source: 'defaults', path: p };
    }
    const yamlOnly = parseSharedFile(p);
    return { config: loadEffectiveSharedConfig(yamlOnly, rtDir), source: 'file', path: p };
  }
  const p = defaultConfigPath();
  if (existsSync(p)) {
    const yamlOnly = parseSharedFile(p);
    return { config: loadEffectiveSharedConfig(yamlOnly, rtDir), source: 'file', path: p };
  }
  const yamlOnly = defaultSharedConfig();
  return { config: loadEffectiveSharedConfig(yamlOnly, rtDir), source: 'defaults', path: p };
}

function yamlConfigFromPath(path: string): SharedConfig {
  const p = resolve(path);
  if (!existsSync(p)) return defaultSharedConfig();
  return parseSharedFile(p);
}

function runtimeGatewayDirArg(explicit?: string): string {
  return explicit ?? getLayout().state('gateway');
}

function persistViaRuntime(
  configPath: string,
  runtimeGatewayDir: string | undefined,
  mutate: (store: RuntimeConfigStore, base: SharedConfig) => void,
): SharedConfig {
  const rtDir = runtimeGatewayDirArg(runtimeGatewayDir);
  const base = yamlConfigFromPath(configPath);
  const store = createRuntimeConfigStore(rtDir);
  store.ensureBootstrapped(base);
  mutate(store, base);
  return applyRuntimeOverlay(base, store.loadOverlay());
}

function parseSharedFile(p: string): SharedConfig {
  const raw = readFileSync(p, 'utf8');
  return migrateConfig(parse(raw));
}

// ── gateway token（默认用户的永久凭据，三进程共享）────────────────────────

/** 生成一枚随机永久 token（不写入 yaml，落盘 .runtime-state/gateway-token） */
export function generateGatewayToken(): string {
  return `lg_${randomBytes(24).toString('base64url')}`;
}

/**
 * 读取持久化的 gateway token；文件不存在时自动生成、落盘（0600）并返回。
 * 三进程共享同一文件：首个启动的（通常 gateway）负责生成，其余读取复用。
 */
export function ensureGatewayTokenFile(file?: string): string {
  const p = file ?? getLayout().gatewayTokenFile;
  if (existsSync(p)) {
    const existing = readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  }
  const token = generateGatewayToken();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 等不支持 chmod 时忽略 */
  }
  return token;
}

/** 只读持久化 token；不存在返回空串（不生成，供非 gateway 进程使用） */
export function readGatewayTokenFile(file?: string): string {
  const p = file ?? getLayout().gatewayTokenFile;
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

export interface ResolvedGatewayAuth {
  mode: AuthMode;
  /** 生效中的永久 gateway token（配置优先，否则取/建 token 文件） */
  token: string;
  sessionTtlDays: number;
}

/**
 * 解析 gateway 进程实际使用的鉴权参数：
 * - open：不鉴权，token 置空；
 * - local/token：auth.token 配置优先；留空则读（gateway 进程）/建 token 文件。
 */
export function resolveGatewayAuth(config: SharedConfig, tokenFile?: string): ResolvedGatewayAuth {
  const auth = config.gateway.auth;
  if (auth.mode === 'open') return { mode: 'open', token: '', sessionTtlDays: auth.sessionTtlDays };
  const configured = auth.token.trim();
  const token = configured || ensureGatewayTokenFile(tokenFile);
  return { mode: auth.mode, token, sessionTtlDays: auth.sessionTtlDays };
}

// ── 子进程（weixin / node）回连网关的运行时推导 ────────────────────────────

/** 0.0.0.0/:: 不能作为回连地址，归一化到 127.0.0.1 */
export function loopbackHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/** 推导网关 HTTP/WS base（http://host:port） */
export function deriveGatewayBase(config: SharedConfig): string {
  const { host, port } = config.gateway.server;
  return `http://${loopbackHost(host)}:${port}`;
}

export interface ChildProcessRuntime {
  gatewayUrl: string;
  gatewayToken: string;
}

/** 比较回连目标是否为同一网关（忽略 http/ws、localhost/127.0.0.1） */
export function sameGatewayOrigin(a: string, b: string): boolean {
  const key = (raw: string): string => {
    const trimmed = raw.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
      const u = new URL(withScheme);
      const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'https' : 'http';
      let host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '::1') host = '127.0.0.1';
      const port = u.port || (proto === 'https' ? '443' : '80');
      return `${proto}://${host}:${port}`;
    } catch {
      return trimmed.replace(/\/+$/, '').toLowerCase();
    }
  };
  return key(a) === key(b);
}

/**
 * 子进程共享的回连参数：env > 配置段 > 推导缺省。
 * 回连本机网关时，token 还可回退 gateway.auth.token / token 文件；
 * 回连另一台网关时不再套用本机令牌（否则会被对端 401）。
 */
export function resolveChildRuntime(
  config: SharedConfig,
  section: { gatewayUrl?: string; gatewayToken?: string },
  env: { url?: string; token?: string } = {},
  tokenFile?: string,
): ChildProcessRuntime {
  const gatewayUrl = env.url?.trim() || section.gatewayUrl?.trim() || deriveGatewayBase(config);
  const explicitToken = env.token?.trim() || section.gatewayToken?.trim() || '';
  if (explicitToken) return { gatewayUrl, gatewayToken: explicitToken };
  const localToken = config.gateway.auth.token.trim() || readGatewayTokenFile(tokenFile);
  const gatewayToken = sameGatewayOrigin(gatewayUrl, deriveGatewayBase(config)) ? localToken : '';
  return { gatewayUrl, gatewayToken };
}

// ── 旧扁平加载（迁移期兼容：现有测试与调用方仍引用 loadGatewayConfig）──────

export interface LoadedConfig {
  config: GatewayConfig;
  source: 'file' | 'defaults';
  path: string;
}

/**
 * @deprecated 三进程共享配置请用 {@link loadSharedConfig}。
 * 保留旧签名：返回迁移后还原的扁平形状，供既有测试/调用方过渡。
 */
export function loadGatewayConfig(pathArg?: string, runtimeGatewayDir?: string): LoadedConfig {
  const shared = loadSharedConfig(pathArg, runtimeGatewayDir);
  const flat = gatewaySectionToLegacy(shared.config);
  return { config: flat, source: shared.source, path: shared.path };
}

/** 三段式 → 旧扁平形状（gatewayConfigSchema 的等价产物） */
export function gatewaySectionToLegacy(cfg: SharedConfig): GatewayConfig {
  return gatewayConfigSchema.parse({
    gateway: {
      server: cfg.gateway.server,
      auth: {
        mode: cfg.gateway.auth.mode,
        token: cfg.gateway.auth.token,
        sessionTtlDays: cfg.gateway.auth.sessionTtlDays,
      },
      agents: cfg.gateway.agents,
      defaultCwd: cfg.gateway.defaultCwd,
      channels: cfg.gateway.channels,
      plugins: cfg.gateway.plugins,
      tasks: cfg.gateway.tasks,
    },
    weixin: {
      mode: cfg.weixin.mode,
      ...(cfg.weixin.accountId ? { accountId: cfg.weixin.accountId } : {}),
      ...(cfg.weixin.model ? { model: cfg.weixin.model } : {}),
    },
  }) as GatewayConfig;
}

const WEIXIN_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;

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
  if (effective.weixin.mode !== 'external') {
    throw new Error('持久化校验失败：weixin.mode 未更新为 external');
  }
  if (effective.weixin.enabled !== true) {
    throw new Error('持久化校验失败：weixin.enabled 未打开');
  }
  return [...effective.weixin.accounts];
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

/** 重新导出旧默认值，兼容既有 import */
export { defaultConfig };
