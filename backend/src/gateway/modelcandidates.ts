/**
 * 候选模型收集：从本机真实配置尽力读取各 agent 可用的模型列表，供控制台「切换模型」下拉。
 * - opencode：~/.config/opencode/opencode.json（或仓库根 opencode.json）provider.<id>.models 的键
 * - pi：       ~/.pi/agent/models.json provider.<id>.models[].id
 * 结果统一为 "providerId/modelId"（如 volcengine/deepseek-v4-flash-ga-260731），与
 * AcpAdapter 通过 ACP set_config_option('model') 下发的取值一致。
 * 文件缺失 / 结构不符 / 解析失败一律静默降级为空列表（UI 仍可手动输入模型）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from './config.js';

export type CandidateKind = 'opencode' | 'pi';

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
  const paths = [join(homedir(), '.config', 'opencode', 'opencode.json'), join(findRepoRoot(), 'opencode.json')];
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

/** 按 agent 后端类型收集候选；未知类型或读取失败返回空数组 */
export function collectModelCandidates(kind: CandidateKind): string[] {
  try {
    if (kind === 'opencode') return collectOpencodeCandidates();
    if (kind === 'pi') return collectPiCandidates();
    return [];
  } catch {
    return [];
  }
}
