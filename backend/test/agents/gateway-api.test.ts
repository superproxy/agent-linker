import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

/** 集成测试临时状态根目录（after hook 统一清理），避免污染真实 .runtime-state */
const TMP_ROOTS: string[] = [];
after(() => {
  for (const root of TMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

async function freshBuilt(definitions: { id: string; type: string; displayName: string }[]): Promise<Built> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'linkagent-agents-'));
  TMP_ROOTS.push(stateRoot);
  return buildServer({ configPath: 'test/fixtures/gateway.test.yaml', definitions: definitions as never, stateRoot });
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
    assert.ok(typeof codex.installCommand === 'string' && codex.installCommand.length > 0);
    assert.equal(typeof codex.installRunnable, 'boolean');
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('GET /api/agents/by-node：本机分组含完整可编辑运行态 + 默认 agent；远程节点只读自报', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, nodeManager, pluginManager } = built;
  try {
    const res = await app.inject({ method: 'GET', url: '/api/agents/by-node' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      defaultAgentId: string;
      local: { nodeId: string; name: string; online: boolean; status: string; agents: { id: string; enabled: boolean }[] };
      nodes: unknown[];
    };
    assert.equal(body.defaultAgentId, 'opencode');
    assert.equal(body.local.nodeId, 'local');
    assert.equal(body.local.online, true);
    assert.equal(body.local.status, 'approved');
    assert.ok(body.local.agents.some((a) => a.id === 'opencode' && a.enabled === true));
    assert.ok(Array.isArray(body.nodes));

    // 远程节点（含在线/离线）只读自报其开通的 agent，网关不做可编辑字段（stub 隔离真实注册表）
    nodeManager.list = () => [
      {
        nodeId: 'n_aaa',
        name: 'build-box',
        online: true,
        status: 'approved',
        agents: [{ id: 'codex', displayName: 'Codex' }],
        version: '0.1.0',
        connectedAt: 1,
        lastSeenAt: 2,
      },
      {
        nodeId: 'n_bbb',
        name: 'offline-box',
        online: false,
        status: 'approved',
        agents: [{ id: 'pi' }],
        lastSeenAt: 3,
      },
    ] as never;
    const res2 = await app.inject({ method: 'GET', url: '/api/agents/by-node' });
    assert.equal(res2.statusCode, 200);
    const nodes = res2.json().nodes as { nodeId: string; online: boolean; agents: { id: string }[] }[];
    assert.equal(nodes.length, 2);
    const online = nodes.find((n) => n.nodeId === 'n_aaa');
    assert.ok(online);
    assert.equal(online?.online, true);
    assert.deepEqual(online?.agents, [{ id: 'codex', displayName: 'Codex' }]);
    const offline = nodes.find((n) => n.nodeId === 'n_bbb');
    assert.equal(offline?.online, false);
    assert.deepEqual(offline?.agents, [{ id: 'pi' }]);

    // 本机停用一个 agent 后，by-node 的本机分组应反映（可编辑运行态）
    manager.updateAgent('opencode', { enabled: false });
    const res3 = await app.inject({ method: 'GET', url: '/api/agents/by-node' });
    const localAgents = res3.json().local.agents as { id: string; enabled: boolean }[];
    assert.equal(localAgents.find((a) => a.id === 'opencode')?.enabled, false);
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

test('POST /api/agents/install：未知类型 / 不可代执行 400', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, pluginManager } = built;
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/agents/install', payload: { type: 'ghost' } });
    assert.equal(bad.statusCode, 400);

    const skip = await app.inject({ method: 'POST', url: '/api/agents/install', payload: { type: 'cursor' } });
    assert.equal(skip.statusCode, 400);
    assert.equal(skip.json().error.code, 'install_not_runnable');
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});
