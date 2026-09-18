import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isMap, parse, parseDocument, YAMLMap } from 'yaml';
import {
  migrateConfig,
  defaultSharedConfig,
  type AuthMode,
  type SharedConfig,
  // 旧扁平形状（迁移期兼容）
  gatewayConfigSchema,
  defaultConfig,
  type GatewayConfig,
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

/**
 * 子进程共享的回连参数：env > 配置段 > 推导缺省。
 * @param envUrl / envToken  调用方传入的环境变量值（已读取，缺省空串）
 * @param sectionUrl / sectionToken  配置段里显式填写的值
 */
export function resolveChildRuntime(
  config: SharedConfig,
  section: { gatewayUrl?: string; gatewayToken?: string },
  env: { url?: string; token?: string } = {},
  tokenFile?: string,
): ChildProcessRuntime {
  const gatewayUrl = env.url?.trim() || section.gatewayUrl?.trim() || deriveGatewayBase(config);
  // token：env > 配置段 > gateway.auth.token > token 文件（只读，不创建）
  // tokenFile 显式透传以支持测试/多实例 layout 隔离；缺省回退全局安装布局。
  const gatewayToken =
    env.token?.trim() ||
    section.gatewayToken?.trim() ||
    config.gateway.auth.token.trim() ||
    readGatewayTokenFile(tokenFile);
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
