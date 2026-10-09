import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskTranscripts, turnsFromAcpMessages } from '../../src/gateway/tasks/transcript.js';

test('ACP 会话：跳过 Agent 上下文，合并重复的 User 前缀，只留下新的一句', () => {
  const turns = turnsFromAcpMessages([
    { Agent: { content: [{ Text: '## Context\nAGENTS.md' }] } },
    { User: { content: [{ Text: 'User: 你好' }] } },
    { User: { content: [{ Text: 'User: 你好，回复ok' }] } },
    {
      User: {
        content: [{ Text: 'User: 你好，回复ok\n\nAssistant: ok\n\nUser: reply ok' }],
      },
    },
    { User: { content: [{ Text: 'User: reply ok' }] } },
  ]);
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.content}`),
    ['user:你好', 'user:你好，回复ok', 'assistant:ok', 'user:reply ok'],
  );
});

test('首次加载把 ACP 对话写入网关，之后删除节点文件仍能加载', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkagent-transcript-'));
  const key = 'local:web:local:task:t_41db7238';
  const sessionDir = join(root, 'node', 'acpx', 'pi', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `${encodeURIComponent(key)}.json`),
    JSON.stringify({
      messages: [
        { Agent: { content: [{ Text: '## Skills' }] } },
        { User: { content: [{ Text: 'User: 你好' }] } },
        { User: { content: [{ Text: 'User: reply ok' }] } },
      ],
    }),
    'utf8',
  );
  const store = createTaskTranscripts(join(root, 'kv'), join(root, 'node'));
  assert.deepEqual(
    store.load(key, 'pi').map((t) => t.content),
    ['你好', 'reply ok'],
  );
  rmSync(sessionDir, { recursive: true, force: true });
  assert.deepEqual(
    store.load(key, 'pi').map((t) => t.content),
    ['你好', 'reply ok'],
  );
  store.append(key, 'pi', '再问一次', { content: '好的' });
  const saved = store.load(key, 'pi');
  assert.deepEqual(
    saved.map((t) => `${t.role}:${t.content}:${t.error ?? ''}`),
    ['user:你好:', 'user:reply ok:', 'user:再问一次:', 'assistant:好的:'],
  );
});

test('网关还没有记录时，本轮写入会并入 ACP 历史且不重复最后一句', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkagent-transcript-'));
  const key = 'local:web:local:task:t_new';
  const sessionDir = join(root, 'node', 'acpx', 'pi', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `${encodeURIComponent(key)}.json`),
    JSON.stringify({
      messages: [
        { User: { content: [{ Text: 'User: 你好' }] } },
        { User: { content: [{ Text: 'User: reply ok' }] } },
      ],
    }),
    'utf8',
  );
  const store = createTaskTranscripts(join(root, 'kv'), join(root, 'node'));
  store.append(key, 'pi', 'reply ok', { content: '', error: 'agent 未返回内容' });
  assert.deepEqual(
    store.load(key, 'pi').map((t) => `${t.role}:${t.content}:${t.error ?? ''}`),
    ['user:你好:', 'user:reply ok:', 'assistant::agent 未返回内容'],
  );
});
