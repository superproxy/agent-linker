import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_AGENT_KINDS, defaultAgentDefinitions } from '@linkagent/shared';
import type { AgentDefinition } from '@linkagent/shared';
import { AgentManager } from '../../src/gateway/agents/manager.js';

function freshManager(definitions: AgentDefinition[] = defaultAgentDefinitions()): AgentManager {
  return new AgentManager({
    definitions,
    stateDir: mkdtempSync(join(tmpdir(), 'linkagent-agents-')),
    repoRoot: process.cwd(),
  });
}

test('listAgentCatalog：默认 agent 已配置启用，其余支持类型未配置且带命令', async () => {
  const m = freshManager();
  await m.start();
  const catalog = m.listAgentCatalog();
  assert.equal(catalog.length, ACP_AGENT_KINDS.length);
  for (const kind of ['opencode', 'pi', 'workbuddy', 'trace-cli', 'cursor'] as const) {
    const item = catalog.find((c) => c.kind === kind);
    assert.ok(item, `缺目录项 ${kind}`);
    assert.equal(item.configured, true);
    assert.equal(item.enabled, true);
  }
  const cursor = catalog.find((c) => c.kind === 'cursor');
  assert.deepEqual(cursor?.command, ['agent', 'acp']);
  assert.equal(cursor?.installRunnable, false);
  assert.ok(cursor?.installCommand);
  const zcode = catalog.find((c) => c.kind === 'zcode');
  assert.equal(zcode?.installRunnable, true);
  assert.equal(zcode?.installCommand, 'npm i -g zcode-acp-server');
  for (const kind of ['codex', 'claude', 'gemini', 'qwen', 'openclaw', 'zcode'] as const) {
    const item = catalog.find((c) => c.kind === kind);
    assert.ok(item, `缺目录项 ${kind}`);
    assert.equal(item.configured, false);
    assert.equal(item.enabled, false);
    assert.ok(item.command.length > 0, `目录项 ${kind} 缺默认命令`);
  }
  await m.dispose();
});

test('addAgent：热添加成功，可解析可停用，目录状态联动', async () => {
  const m = freshManager();
  await m.start();
  const detail = m.addAgent({
    id: 'codex',
    type: 'codex',
    displayName: 'Codex',
    description: 'test',
  });
  assert.equal(detail.id, 'codex');
  assert.equal(detail.enabled, true);
  assert.ok(m.has('agent:codex'));
  assert.ok(m.resolve('agent:codex'), 'resolve 应命中新添加的 agent');

  const cat = m.listAgentCatalog().find((c) => c.kind === 'codex');
  assert.equal(cat?.configured, true);
  assert.equal(cat?.enabled, true);

  const stopped = m.updateAgent('codex', { enabled: false });
  assert.equal(stopped.enabled, false);
  assert.equal(m.resolve('agent:codex'), undefined, '停用后不应被解析');
  const cat2 = m.listAgentCatalog().find((c) => c.kind === 'codex');
  assert.equal(cat2?.enabled, false);

  const details = m.listAgentDetails();
  assert.ok(details.some((d) => d.id === 'codex' && !d.enabled));
  await m.dispose();
});

test('addAgent：id 重复 / 未知类型抛错', async () => {
  const m = freshManager();
  await m.start();
  assert.throws(() => m.addAgent({ id: 'opencode', type: 'opencode' }), /已存在/);
  assert.throws(
    () => m.addAgent({ id: 'ghost', type: 'not-a-kind' } as unknown as AgentDefinition),
    /未知 agent 类型/,
  );
  await m.dispose();
});
