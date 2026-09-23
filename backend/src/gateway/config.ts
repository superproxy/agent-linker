import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isMap, isSeq, parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
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
} from '@linkagent/shared';
import { findInstallRoot, findRepoRoot, getLayout } from '../install/layout.js';

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
export function loadSharedConfig(pathArg?: string): LoadedSharedConfig {
  const explicit = process.env.GATEWAY_CONFIG_PATH || pathArg;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
    return { config: parseSharedFile(p), source: 'file', path: p };
  }
  const p = defaultConfigPath();
  if (existsSync(p)) return { config: parseSharedFile(p), source: 'file', path: p };
  return { config: defaultSharedConfig(), source: 'defaults', path: p };
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
export function loadGatewayConfig(pathArg?: string): LoadedConfig {
  const shared = loadSharedConfig(pathArg);
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

/**
 * 持久化「默认任务绑定的 agent」到 config.yaml 的 gateway.tasks.defaultAgentId（重启保留）。
 * - 用 YAML Document API 就地改值，最大程度保留原有注释 / 键序 / 格式；
 * - 兼容旧扁平文件（顶层 tasks）与新三段文件（gateway.tasks）；
 * - 文件不存在则新建最小 gateway.tasks 段。
 * 返回写入的绝对路径。
 */
export function persistDefaultTaskAgentId(path: string, agentId: string): string {
  const p = resolve(path);
  const id = agentId.trim();
  if (!id) throw new Error('defaultAgentId 不能为空');

  let doc = parseDocument('');
  let isNewShape = false;
  if (existsSync(p)) {
    const raw = readFileSync(p, 'utf8');
    doc = parseDocument(raw);
    isNewShape = doc.has('gateway');
  } else {
    mkdirSync(dirname(p), { recursive: true });
  }

  if (isNewShape) {
    const gateway = doc.get('gateway') as { get?: (k: string) => unknown; set?: (k: string, v: unknown) => void } | null;
    const tasks = gateway && typeof gateway.get === 'function' ? (gateway.get('tasks') as { set?: (k: string, v: unknown) => void } | null) : null;
    if (tasks && typeof tasks.set === 'function') {
      tasks.set('defaultAgentId', id);
    } else if (gateway && typeof gateway.set === 'function') {
      gateway.set('tasks', { defaultAgentId: id });
    } else {
      doc.set('gateway', { tasks: { defaultAgentId: id } });
    }
  } else {
    const tasks = doc.get('tasks') as { set?: (key: string, value: unknown) => void } | null;
    if (tasks && typeof tasks.set === 'function') {
      tasks.set('defaultAgentId', id);
    } else {
      doc.set('tasks', { defaultAgentId: id });
    }
  }

  writeFileSync(p, doc.toString(), 'utf8');

  // 重新解析校验：两种形状都归一化后核对
  const reparsed = migrateConfig(parse(readFileSync(p, 'utf8')));
  if (reparsed.gateway.tasks.defaultAgentId !== id) {
    throw new Error(`持久化校验失败：tasks.defaultAgentId 未更新为 ${id}`);
  }
  return p;
}

function agentsSeqOf(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  const isNewShape = doc.has('gateway');
  if (isNewShape) {
    let gateway = doc.get('gateway');
    if (!isMap(gateway)) {
      doc.set('gateway', new YAMLMap());
      gateway = doc.get('gateway');
    }
    const g = gateway as YAMLMap;
    let agents = g.get('agents');
    if (!isSeq(agents)) {
      agents = new YAMLSeq();
      g.set('agents', agents);
    }
    return agents as YAMLSeq;
  }
  let agents = doc.get('agents');
  if (!isSeq(agents)) {
    agents = new YAMLSeq();
    doc.set('agents', agents);
  }
  return agents as YAMLSeq;
}

function seedAgentsSeq(seq: YAMLSeq, defs: AgentDefinition[]): void {
  if (seq.items.length > 0) return;
  for (const d of defs) {
    const m = new YAMLMap();
    m.set('id', d.id);
    m.set('type', d.type);
    if (d.displayName) m.set('displayName', d.displayName);
    m.set('enabled', d.enabled !== false);
    seq.add(m);
  }
}

/**
 * 把某个本机 agent 的启用状态写入 config.yaml（gateway.agents 或旧顶层 agents）。
 * yaml 里还没有 agents 列表时，用当前运行定义整表落下再改目标项，避免重启丢回默认全开。
 */
export function persistAgentEnabled(
  path: string,
  agentId: string,
  enabled: boolean,
  defs: AgentDefinition[],
): AgentDefinition[] {
  const id = agentId.trim();
  if (!id) throw new Error('agentId 不能为空');
  const p = resolve(path);
  const doc = parseDocument(existsSync(p) ? readFileSync(p, 'utf8') : '');
  if (!existsSync(p)) mkdirSync(dirname(p), { recursive: true });
  const seq = agentsSeqOf(doc);
  seedAgentsSeq(seq, defs);

  let found = false;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    if (String(item.get('id') ?? '') !== id) continue;
    item.set('enabled', enabled);
    found = true;
    break;
  }
  if (!found) {
    const src = defs.find((d) => d.id === id);
    if (!src) throw new Error(`未知 agent: ${id}`);
    const m = new YAMLMap();
    m.set('id', src.id);
    m.set('type', src.type);
    if (src.displayName) m.set('displayName', src.displayName);
    m.set('enabled', enabled);
    seq.add(m);
  }

  writeFileSync(p, doc.toString(), 'utf8');
  const reparsed = migrateConfig(parse(readFileSync(p, 'utf8')));
  const hit = reparsed.gateway.agents.find((a) => a.id === id);
  if (!hit) throw new Error(`持久化校验失败：gateway.agents 未包含 ${id}`);
  const nowOn = hit.enabled !== false;
  if (nowOn !== enabled) {
    throw new Error(`持久化校验失败：${id}.enabled 未更新为 ${enabled}`);
  }
  return [...reparsed.gateway.agents];
}

function nodeAgentsSeqOf(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  let node = doc.get('node');
  if (!isMap(node)) {
    doc.set('node', new YAMLMap());
    node = doc.get('node');
  }
  const n = node as YAMLMap;
  let agents = n.get('agents');
  if (!isSeq(agents)) {
    agents = new YAMLSeq();
    n.set('agents', agents);
  }
  return agents as YAMLSeq;
}

/**
 * 把 agent id 登记进 node.agents（节点连接器握手自报清单）。
 * 任务路由 (nodeId, agentId) 以节点注册为准；本机 pm 托管的 node 进程只读此列表（不读环境变量）。
 */
export function persistNodeAgentRegistered(path: string, agentId: string): string[] {
  const id = normalizeAgentId(agentId);
  if (!id) throw new Error('agentId 不能为空');
  const p = resolve(path);
  const doc = parseDocument(existsSync(p) ? readFileSync(p, 'utf8') : '');
  if (!existsSync(p)) mkdirSync(dirname(p), { recursive: true });
  const seq = nodeAgentsSeqOf(doc);
  const exists = seq.items.some((item) => normalizeAgentId(String(item ?? '')) === id);
  if (!exists) seq.add(id);
  writeFileSync(p, doc.toString(), 'utf8');
  const reparsed = migrateConfig(parse(readFileSync(p, 'utf8')));
  if (!reparsed.node.agents.map(normalizeAgentId).includes(id)) {
    throw new Error(`持久化校验失败：node.agents 未包含 ${id}`);
  }
  return [...reparsed.node.agents];
}

const WEIXIN_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;

function weixinMapOf(doc: ReturnType<typeof parseDocument>): YAMLMap {
  let sec = doc.get('weixin');
  if (!isMap(sec)) {
    doc.set('weixin', new YAMLMap());
    sec = doc.get('weixin');
  }
  return sec as YAMLMap;
}

function weixinAccountIdsFromMap(map: YAMLMap): string[] {
  const raw = map.get('accounts') as { toJSON?: () => unknown } | unknown;
  const json =
    raw && typeof raw === 'object' && typeof (raw as { toJSON?: () => unknown }).toJSON === 'function'
      ? (raw as { toJSON: () => unknown }).toJSON()
      : raw;
  if (!Array.isArray(json)) return [];
  return json.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * 把登录用户对应的微信账号 id 写入 weixin.accounts，并把 mode 设为 external（每用户独立 bot 进程）。
 * 已存在则只保证 mode=external。返回落盘后的 accounts 列表。
 */
export function persistEnsureWeixinAccount(path: string, accountId: string): string[] {
  const id = accountId.trim();
  if (!WEIXIN_ACCOUNT_ID_RE.test(id)) throw new Error(`非法微信账号 id: ${accountId}`);
  const p = resolve(path);
  const doc = parseDocument(existsSync(p) ? readFileSync(p, 'utf8') : '');
  if (!existsSync(p)) mkdirSync(dirname(p), { recursive: true });
  const map = weixinMapOf(doc);
  const ids = weixinAccountIdsFromMap(map);
  if (!ids.includes(id)) ids.push(id);
  map.set('accounts', ids);
  map.set('mode', 'external');
  map.set('enabled', true);
  writeFileSync(p, doc.toString(), 'utf8');
  const reparsed = migrateConfig(parse(readFileSync(p, 'utf8')));
  if (!reparsed.weixin.accounts.includes(id)) {
    throw new Error(`持久化校验失败：weixin.accounts 未包含 ${id}`);
  }
  if (reparsed.weixin.mode !== 'external') {
    throw new Error('持久化校验失败：weixin.mode 未更新为 external');
  }
  if (reparsed.weixin.enabled !== true) {
    throw new Error('持久化校验失败：weixin.enabled 未打开');
  }
  return [...reparsed.weixin.accounts];
}

/** 从 weixin.accounts 去掉已删除登录用户对应的账号 id（不改变 mode） */
export function persistRemoveWeixinAccount(path: string, accountId: string): string[] {
  const id = accountId.trim();
  if (!WEIXIN_ACCOUNT_ID_RE.test(id) || !existsSync(resolve(path))) return [];
  const p = resolve(path);
  const doc = parseDocument(readFileSync(p, 'utf8'));
  if (!isMap(doc.get('weixin'))) return [];
  const map = weixinMapOf(doc);
  const ids = weixinAccountIdsFromMap(map).filter((x) => x !== id);
  map.set('accounts', ids);
  writeFileSync(p, doc.toString(), 'utf8');
  return [...migrateConfig(parse(readFileSync(p, 'utf8'))).weixin.accounts];
}

/** 可改挂载网关的子进程段（weixin / node 进程，配置里均为顶层同名段） */
export type ChildSectionId = 'weixin' | 'node';

export interface ChildGatewayTarget {
  /** 远程网关 base；空串表示切回本机网关（清空该段回连地址，恢复缺省推导） */
  url: string;
  /** 回连凭据；切回本机或远程网关免鉴权时留空 */
  token: string;
}

/**
 * 持久化微信 / node 进程的挂载网关到 config.yaml 的 <section>.gatewayUrl/gatewayToken：
 * - 两种文件形状统一：新三段与旧扁平文件里 weixin/node 均为顶层段；
 * - url 非空：写入 gatewayUrl，有 token 写 gatewayToken、无 token 则清除旧 token；
 * - url 为空（切回本机）：删除 gatewayUrl/gatewayToken 两个键；
 * - 文件不存在则新建；用 YAML Document API 就地改，保留原有注释与键序。
 * 返回写入的绝对路径。
 */
export function persistChildGatewayTarget(
  path: string,
  section: ChildSectionId,
  target: ChildGatewayTarget,
): string {
  const p = resolve(path);
  const url = target.url.trim().replace(/\/+$/, '');
  const token = target.token.trim();
  if (url && !/^https?:\/\/\S+$/.test(url)) {
    throw new Error('网关地址需以 http:// 或 https:// 开头');
  }

  let doc = parseDocument('');
  if (existsSync(p)) {
    doc = parseDocument(readFileSync(p, 'utf8'));
  } else {
    mkdirSync(dirname(p), { recursive: true });
  }

  let sec = doc.get(section) as unknown;
  if (url) {
    if (!isMap(sec)) {
      doc.set(section, new YAMLMap());
      sec = doc.get(section);
    }
    const map = sec as YAMLMap;
    map.set('gatewayUrl', url);
    if (token) map.set('gatewayToken', token);
    else map.delete('gatewayToken');
  } else if (isMap(sec)) {
    (sec as YAMLMap).delete('gatewayUrl');
    (sec as YAMLMap).delete('gatewayToken');
  }

  writeFileSync(p, doc.toString(), 'utf8');

  // 重新解析校验（两种形状都归一化）
  const reparsed = migrateConfig(parse(readFileSync(p, 'utf8')));
  const gotUrl = reparsed[section].gatewayUrl;
  if ((url || '') !== gotUrl) {
    throw new Error(`持久化校验失败：${section}.gatewayUrl 未更新为 ${url || '（本机）'}`);
  }
  return p;
}

/** 重新导出旧默认值，兼容既有 import */
export { defaultConfig };
