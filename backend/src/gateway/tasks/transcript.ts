import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKvJsonStore } from '../store/kv.js';

export interface TaskChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: string;
}

interface SavedTranscript {
  messages: TaskChatMessage[];
}

/** 从 ACP 会话 JSON 的 messages 数组抽出可展示的对话，跳过系统上下文。 */
export function turnsFromAcpMessages(messages: unknown): TaskChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const merged: TaskChatMessage[] = [];
  for (const item of messages) {
    const text = userTextOf(item);
    if (!text) continue;
    const turns = parseLabeled(text);
    const next = turns.length > 0 ? turns : [{ role: 'user' as const, content: text.replace(/^User:\s*/, '').trim() }].filter((t) => t.content);
    appendNovelTurns(merged, next);
  }
  return merged;
}

export function readAcpSessionTurns(nodeStateDir: string, agentId: string, sessionKey: string): TaskChatMessage[] {
  const agent = agentId.trim();
  const key = sessionKey.trim();
  if (!agent || !key) return [];
  const file = join(nodeStateDir, 'acpx', agent, 'sessions', `${encodeURIComponent(key)}.json`);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { messages?: unknown };
    return turnsFromAcpMessages(parsed.messages);
  } catch {
    return [];
  }
}

/**
 * 任务对话记录落在网关 KV。用户加载时只读这里。
 * 网关还没有记录时，把节点 ACP 会话导入并写入，之后不再依赖那份文件。
 * 新的一轮若还没导入过，会先并入 ACP 记录，避免只留下最新一句。
 */
export function createTaskTranscripts(kvDir: string, nodeStateDir: string): {
  load(sessionKey: string, agentId: string): TaskChatMessage[];
  append(sessionKey: string, agentId: string, userText: string, assistant: { content: string; error?: string }): void;
} {
  const kv = createKvJsonStore<SavedTranscript>(kvDir);
  const fromAcp = (sessionKey: string, agentId: string) => readAcpSessionTurns(nodeStateDir, agentId, sessionKey);
  return {
    load(sessionKey, agentId) {
      const saved = kv.get(sessionKey)?.messages;
      if (saved) return saved;
      const imported = fromAcp(sessionKey, agentId);
      if (imported.length > 0) kv.put(sessionKey, { messages: imported });
      return imported;
    },
    append(sessionKey, agentId, userText, assistant) {
      const user = userText.trim();
      if (!user) return;
      const saved = kv.get(sessionKey)?.messages;
      let messages = saved ? [...saved] : fromAcp(sessionKey, agentId);
      const last = messages.at(-1);
      if (!saved && last?.role === 'user' && last.content === user) messages = messages.slice(0, -1);
      messages.push({ role: 'user', content: user });
      const content = assistant.content.trim();
      const error = assistant.error?.trim();
      if (content || error) {
        messages.push({
          role: 'assistant',
          content,
          ...(error ? { error } : {}),
        });
      }
      kv.put(sessionKey, { messages });
    },
  };
}

function userTextOf(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const rec = item as Record<string, unknown>;
  const user = rec.User ?? rec.user;
  if (!user || typeof user !== 'object') return '';
  const content = (user as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const row = part as Record<string, unknown>;
      if (typeof row.Text === 'string') return row.Text;
      if (typeof row.text === 'string') return row.text;
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
}

function parseLabeled(text: string): TaskChatMessage[] {
  const chunks = text.split(/\n\n(?=(?:User|Assistant): )/);
  const out: TaskChatMessage[] = [];
  for (const chunk of chunks) {
    const matched = /^(User|Assistant):\s*([\s\S]*)$/.exec(chunk.trim());
    if (!matched) continue;
    const content = (matched[2] ?? '').trim();
    if (!content) continue;
    out.push({ role: matched[1] === 'User' ? 'user' : 'assistant', content });
  }
  return out;
}

function appendNovelTurns(merged: TaskChatMessage[], turns: TaskChatMessage[]): void {
  let overlap = 0;
  const max = Math.min(merged.length, turns.length);
  for (let n = max; n > 0; n -= 1) {
    let same = true;
    for (let j = 0; j < n; j += 1) {
      const left = merged[merged.length - n + j];
      const right = turns[j];
      if (!left || !right || left.role !== right.role || left.content !== right.content) {
        same = false;
        break;
      }
    }
    if (same) {
      overlap = n;
      break;
    }
  }
  for (const turn of turns.slice(overlap)) merged.push(turn);
}
