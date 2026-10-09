/**
 * 候选模型收集：从本机真实配置尽力读取各 agent 可用的模型列表，供控制台「切换模型」下拉。
 * - opencode：  ~/.config/opencode/opencode.json（或仓库根 opencode.json）provider.<id>.models 的键
 * - pi：        ~/.pi/agent/models.json provider.<id>.models[].id
 * - 其它类型（workbuddy/trace-cli/codex/…）：本地模型配置路径暂无公开文档，暂不收集（返回空列表，UI 可手动输入）
 * 结果统一为 "providerId/modelId"（与本机该 agent 配置文件一致），与
 * AcpWrapper 通过 ACP set_config_option('model') 下发的取值一致。
 * 网关不写死火山等厂商模型；pi 的清单以 ~/.pi/agent/models.json 为准。
 * 文件缺失 / 结构不符 / 解析失败一律静默降级为空列表（UI 仍可手动输入模型）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpAgentKind } from '@linkagent/shared';
import { getLayout } from '../install/layout.js';

export type CandidateKind = AcpAgentKind;

type MaybeRecord = Record<string, unknown>;

function tryReadJson(path: string): MaybeRecord | null {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as MaybeRecord) : null;
  } catch {
    return null;
  }
}

/** 从 provider.<id>.models 提取候选；models 兼容 record（键=模型 id）与数组（[{id}]） */
function collectFromProviderModels(doc: MaybeRecord | null, prefix: string): string[] {
  if (!doc) return [];
  const out = new Set<string>();
  const providers = doc[prefix];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  for (const [providerId, cfg] of Object.entries(providers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const models = (cfg as MaybeRecord).models;
    if (!models) continue;
    const ids: string[] = [];
    if (Array.isArray(models)) {
      for (const m of models) {
        if (m && typeof m === 'object' && typeof (m as MaybeRecord).id === 'string') ids.push((m as MaybeRecord).id as string);
      }
    } else if (typeof models === 'object') {
      ids.push(...Object.keys(models as MaybeRecord));
    }
    for (const mid of ids) {
      if (mid.trim() !== '') out.add(`${providerId}/${mid.trim()}`);
    }
  }
  return [...out];
}

/** 兼容顶层 model / small_model 这类 "providerId/modelId" 写法（仅当 providerId 已声明） */
function collectFromTopLevelModelIds(doc: MaybeRecord | null, knownProviderIds: ReadonlySet<string>): string[] {
  if (!doc) return [];
  const out: string[] = [];
  for (const key of ['model', 'small_model'] as const) {
    const v = doc[key];
    if (typeof v === 'string' && /^[^/]+\/[^/]+$/.test(v)) {
      const providerId = v.split('/')[0] ?? '';
      if (knownProviderIds.has(providerId)) out.push(v);
    }
  }
  return out;
}

function collectOpencodeCandidates(): string[] {
  const paths = [join(homedir(), '.config', 'opencode', 'opencode.json'), join(getLayout().root, 'opencode.json')];
  for (const p of paths) {
    const doc = tryReadJson(p);
    if (!doc) continue;
    const providers = doc.provider;
    const known = new Set(
      providers && typeof providers === 'object' && !Array.isArray(providers) ? Object.keys(providers as MaybeRecord) : [],
    );
    const fromProviders = collectFromProviderModels(doc, 'provider');
    const extra = collectFromTopLevelModelIds(doc, known).filter((m) => !fromProviders.includes(m));
    const merged = [...new Set([...fromProviders, ...extra])];
    if (merged.length > 0) return merged.sort();
  }
  return [];
}

function collectPiCandidates(): string[] {
  const doc = tryReadJson(join(homedir(), '.pi', 'agent', 'models.json'));
  const fromProviders = collectFromProviderModels(doc, 'providers');
  return [...new Set(fromProviders)].sort();
}

/** 从 pi settings.json 的 defaultProvider / defaultModel 合成 providerId/modelId */
export function piDefaultModelId(settings: MaybeRecord | null): string | undefined {
  if (!settings) return undefined;
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : '';
  const model = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : '';
  if (!provider || !model || provider.includes('/') || model.includes('/')) return undefined;
  return `${provider}/${model}`;
}

/** 本机 ~/.pi/agent/settings.json 的默认模型；缺失或字段不完整时返回 undefined */
export function readPiDefaultModel(): string | undefined {
  return piDefaultModelId(tryReadJson(join(homedir(), '.pi', 'agent', 'settings.json')));
}

/**
 * 一轮对话实际要下发的会话模型。
 * 显式指定优先；未指定时 pi 用 settings.json 默认模型，用来覆盖持久会话里残留的模型。
 * 其它 agent 没有统一的默认模型文件，未指定则不改会话里已有的模型。
 */
export function resolveTurnModel(
  agentName: string,
  requested: string | undefined,
  piDefault: () => string | undefined = readPiDefaultModel,
): string | undefined {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  if (agentName !== 'pi') return undefined;
  const fallback = piDefault()?.trim();
  return fallback || undefined;
}

/** 按 agent 后端类型收集候选；未知类型或读取失败返回空数组 */
export function collectModelCandidates(kind: CandidateKind): string[] {
  try {
    if (kind === 'opencode') return collectOpencodeCandidates();
    if (kind === 'pi') return collectPiCandidates();
    // workbuddy / trace-cli：本地模型配置路径暂无公开文档，暂不自动收集（UI 手动输入）
    return [];
  } catch {
    return [];
  }
}
