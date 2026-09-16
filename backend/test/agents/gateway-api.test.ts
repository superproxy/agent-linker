import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

async function freshBuilt(definitions: { id: string; type: string; displayName: string }[]): Promise<Built> {
  return buildServer({ configPath: 'test/fixtures/gateway.test.yaml', definitions: definitions as never });
}

test('GET /api/agents/catalog：返回全部支持类型与配置状态', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({ method: 'GET', url: '/api/agents/catalog' });
    assert.equal(res.statusCode, 200);
    const agents = res.json().agents as { kind: string; configured: boolean; enabled: boolean; command: string[] }[];
    assert.ok(agents.length >= 20, `目录应包含全部支持类型，实际 ${agents.length}`);
    const opencode = agents.find((a) => a.kind === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.configured, true);
    assert.equal(opencode.enabled, true);
    const codex = agents.find((a) => a.kind === 'codex');
    assert.ok(codex);
    assert.equal(codex.configured, false);
    assert.equal(codex.enabled, false);
    assert.ok(codex.command.length > 0);
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('POST /api/agents：未知类型 400；重复 409；合法添加 200 且模型列表可见', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, pluginManager } = built;
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/agents', payload: { type: 'ghost' } });
    assert.equal(bad.statusCode, 400);

    const dup = await app.inject({ method: 'POST', url: '/api/agents', payload: { type: 'opencode' } });
    assert.equal(dup.statusCode, 409);

    const ok = await app.inject({ method: 'POST', url: '/api/agents', payload: { type: 'codex' } });
    assert.equal(ok.statusCode, 200);
    const agent = ok.json().agent as { id: string; type: string; enabled: boolean };
    assert.equal(agent.id, 'codex');
    assert.equal(agent.type, 'codex');
    assert.equal(agent.enabled, true);

    const catalog = await app.inject({ method: 'GET', url: '/api/agents/catalog' });
    const codex = (catalog.json().agents as { kind: string; configured: boolean }[]).find((a) => a.kind === 'codex');
    assert.equal(codex?.configured, true);

    const models = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.ok((models.json().data as { id: string }[]).some((m) => m.id === 'agent:codex'));
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});
