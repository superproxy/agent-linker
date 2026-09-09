/**
 * core.channel.pairing —— 配对（allowFrom）存储
 *
 * openclaw 把「已授权用户/群」列表存盘（dmPolicy=pairing / groupPolicy=pairing 时
 * 插件先查 allowFrom 再放行，未匹配则写入配对请求等待 host 审批）。
 * linkagent shim：允许列表以 JSON 文件持久化；host 可在 gateway.yaml 的
 * channels.<id>.allowFrom 直接配置静态放行（更简单，无需配对流程）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AllowFromEntry {
  kind?: string;
  id: string;
  name?: string;
  accountId?: string;
  approvedAt?: number;
}

export interface PairingRequestResult {
  code: string;
  created: boolean;
  existing?: boolean;
}

export interface ChannelPairingStore {
  readAllowFromStore(params: {
    channel: string;
    accountId?: string;
  }): AllowFromEntry[];
  /** 兼容旧签名 (channel, env, accountId) */
  readAllowFromStoreLegacy(
    channel: string,
    env: Record<string, unknown>,
    accountId?: string,
  ): AllowFromEntry[];
  upsertPairingRequest(params: {
    channel: string;
    id: string;
    accountId?: string;
    meta?: Record<string, unknown>;
  }): PairingRequestResult;
  approvePairingRequest(params: { channel: string; code: string; accountId?: string }): boolean;
  root: string;
}

function fileFor(root: string, channel: string, accountId: string, kind: 'allow' | 'pending'): string {
  return join(root, `${kind}.${channel}.${accountId}.json`);
}

export function createChannelPairingStore(stateDir: string): ChannelPairingStore {
  const root = resolve(stateDir, 'pairing');
  mkdirSync(root, { recursive: true });
  const readJson = <T>(p: string, fallback: T): T => {
    try {
      if (!existsSync(p)) return fallback;
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  const writeJson = (p: string, data: unknown): void => {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  };
  return {
    root,
    readAllowFromStore({ channel, accountId }) {
      return readJson<AllowFromEntry[]>(fileFor(root, channel, accountId ?? 'default', 'allow'), []);
    },
    readAllowFromStoreLegacy(channel, _env, accountId) {
      return this.readAllowFromStore({ channel, accountId });
    },
    upsertPairingRequest({ channel, id, accountId, meta }) {
      const acc = accountId ?? 'default';
      const pending = readJson<AllowFromEntry[]>(fileFor(root, channel, acc, 'pending'), []);
      const existing = pending.some((e) => e.id === id);
      if (!existing) {
        pending.push({ id, kind: meta?.kind as string | undefined, name: meta?.name as string | undefined, accountId: acc });
        writeJson(fileFor(root, channel, acc, 'pending'), pending);
      }
      return { code: id, created: !existing, existing };
    },
    approvePairingRequest({ channel, code, accountId }) {
      const acc = accountId ?? 'default';
      const pending = readJson<AllowFromEntry[]>(fileFor(root, channel, acc, 'pending'), []);
      const entry = pending.find((e) => e.id === code);
      if (!entry) return false;
      const allow = this.readAllowFromStore({ channel, accountId: acc });
      allow.push({ ...entry, approvedAt: Date.now() });
      writeJson(fileFor(root, channel, acc, 'allow'), allow);
      writeJson(
        fileFor(root, channel, acc, 'pending'),
        pending.filter((e) => e.id !== code),
      );
      return true;
    },
  };
}
