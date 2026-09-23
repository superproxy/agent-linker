import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { GatewayToNode, NodeToGateway } from '@linkagent/shared';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

const runtimeHome = mkdtempSync(join(tmpdir(), 'linkagent-node-owner-'));

let built: Built;
let app: FastifyInstance;
let adminToken = '';
let aliceToken = '';
let bobToken = '';
let wsBase = '';

before(async () => {
  process.env.LINKAGENT_HOME = runtimeHome;
  built = await buildServer({
    configPath: 'test/fixtures/gateway.auth.yaml',
    stateRoot: join(runtimeHome, 'state'),
    definitions: [{ id: 'pi', type: 'pi', displayName: 'Pi' }] as never,
  });
  app = built.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  wsBase = `ws://127.0.0.1:${port}/api/nodes/ws`;

  const boot = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1' });
  const initial = (boot.json() as { initialAdmin?: { password: string } }).initialAdmin?.password;
  assert.ok(initial);
  adminToken = ((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: initial },
  })).json() as { token: string }).token;

  for (const u of ['alice', 'bob'] as const) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: u, password: 'init-pass-1', displayName: u },
    });
    assert.equal(created.statusCode, 200, created.body);
  }
  aliceToken = ((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'init-pass-1' },
  })).json() as { token: string }).token;
  bobToken = ((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob', password: 'init-pass-1' },
  })).json() as { token: string }).token;
});

after(async () => {
  await built.pluginManager?.dispose().catch(() => {});
  await built.manager.dispose().catch(() => {});
  await built.nodeManager.dispose().catch(() => {});
  await app.close().catch(() => {});
  delete process.env.LINKAGENT_HOME;
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function connectNode(nt: string, nodeId: string): Promise<{ ws: WebSocket; nodeId: string }> {
  const url = `${wsBase}?token=${encodeURIComponent(nt)}`;
  const ws = new WebSocket(url);
  const hello: NodeToGateway = { type: 'hello', name: 'alice-pc', nodeId, agents: [{ id: 'pi' }] };
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as GatewayToNode;
      if (m.type === 'welcome') resolve({ ws, nodeId: m.nodeId });
    });
    ws.on('error', reject);
  });
}

test('nt_ 属主可 disable/enable；他人 403；离线后可 delete', async () => {
  const issued = await app.inject({
    method: 'POST',
    url: '/api/node-tokens',
    headers: auth(aliceToken),
    payload: { label: 'home' },
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const nt = (issued.json() as { token: string }).token;

  const { ws, nodeId } = await connectNode(nt, 'n_alice_pc');
  assert.equal(built.nodeManager.list().find((n) => n.nodeId === nodeId)?.ownerUsername, 'alice');

  const bobDisable = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/disable`,
    headers: auth(bobToken),
  });
  assert.equal(bobDisable.statusCode, 403, bobDisable.body);

  const aliceDisable = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/disable`,
    headers: auth(aliceToken),
  });
  assert.equal(aliceDisable.statusCode, 200, aliceDisable.body);
  assert.equal((aliceDisable.json() as { node: { disabled?: boolean } }).node.disabled, true);

  for (let i = 0; i < 50 && built.nodeManager.isOnline(nodeId); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(built.nodeManager.isOnline(nodeId), false);
  ws.terminate();

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/nodes/${encodeURIComponent(nodeId)}`,
    headers: auth(aliceToken),
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(built.nodeManager.list().find((n) => n.nodeId === nodeId), undefined);
});

test('nt_ 属主可 enable 已停用的节点', async () => {
  const issued = await app.inject({
    method: 'POST',
    url: '/api/node-tokens',
    headers: auth(aliceToken),
    payload: { label: 'lab' },
  });
  const nt = (issued.json() as { token: string }).token;
  const { ws, nodeId } = await connectNode(nt, 'n_alice_lab');
  const disable = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/disable`,
    headers: auth(aliceToken),
  });
  assert.equal(disable.statusCode, 200, disable.body);
  ws.terminate();
  const enable = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/enable`,
    headers: auth(aliceToken),
  });
  assert.equal(enable.statusCode, 200, enable.body);
  assert.equal((enable.json() as { node: { disabled?: boolean } }).node.disabled, undefined);
});
