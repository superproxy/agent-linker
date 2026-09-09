/**
 * core.channel.session —— 会话元数据存储（与 ACP 会话 store 正交）
 *
 * openclaw 用磁盘目录 + JSON 记录每个 sessionKey 的 inbound 元数据
 * （updatedAt / last ctx），供 `formatAgentEnvelope` 计算上次对话时间、
 * 以及插件判断是否新建会话。agent 真实记忆由 ACP 持久会话（acpx session
 * store，见 AcpAdapter sessionKey 复用）承担。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ChannelSessionStore {
  /** 会话根目录（<stateDir>/sessions） */
  root: string;
  resolveStorePath(configured?: unknown, opts?: { agentId?: string }): string;
  recordInboundSession(params: {
    storePath: string;
    sessionKey: string;
    ctx: Record<string, unknown>;
    onRecordError?: (err: unknown) => void;
  }): void;
  readSessionUpdatedAt(params: { storePath: string; sessionKey: string }): number | undefined;
  clear(): void;
}

function hashKey(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 24);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

function fileFor(storePath: string, sessionKey: string): string {
  return join(storePath, `${hashKey(sessionKey)}.json`);
}

export function createChannelSessionStore(stateDir: string): ChannelSessionStore {
  const root = resolve(stateDir, 'sessions');
  mkdirSync(root, { recursive: true });
  return {
    root,
    resolveStorePath(configured?: unknown, opts?: { agentId?: string }) {
      // openclaw：session store path 按 agent 分区；shim 缺省 <root>/<agentId>
      const agentPart = sanitizePathPart(opts?.agentId ?? 'default');
      const p = join(root, agentPart);
      mkdirSync(p, { recursive: true });
      return p;
    },
    recordInboundSession({ storePath, sessionKey, ctx, onRecordError }) {
      try {
        const record = {
          updatedAt: Date.now(),
          sessionKey,
          ctx,
        };
        writeFileSync(fileFor(storePath, sessionKey), JSON.stringify(record), 'utf8');
      } catch (err) {
        onRecordError?.(err);
      }
    },
    readSessionUpdatedAt({ storePath, sessionKey }) {
      try {
        const p = fileFor(storePath, sessionKey);
        if (!existsSync(p)) return undefined;
        const record = JSON.parse(readFileSync(p, 'utf8')) as { updatedAt?: number };
        return typeof record.updatedAt === 'number' ? record.updatedAt : undefined;
      } catch {
        return undefined;
      }
    },
    clear() {
      try {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
      } catch {
        // ignore
      }
    },
  };
}
