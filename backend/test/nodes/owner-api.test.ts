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

/** 匿名申请进入待审批（可选携带 nu_ 归属申明码） */
function connectAnon(nodeId: string, claimToken?: string): Promise<{ ws: WebSocket; nodeId: string }> {
  const ws = new WebSocket(wsBase);
  const hello: NodeToGateway = {
    type: 'hello',
    name: 'anon-pc',
    nodeId,
    agents: [{ id: 'pi' }],
    ...(claimToken ? { claimToken } : {}),
  };
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

test('属主可批准自己的待审批节点；他人 403', async () => {
  const claim = await app.inject({
    method: 'POST',
    url: '/api/node-claims/ensure',
    headers: auth(aliceToken),
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const claimToken = (claim.json() as { claimToken: string }).claimToken;

  const { ws, nodeId } = await connectAnon('n_alice_approve', claimToken);
  const pending = built.nodeManager.list().find((n) => n.nodeId === nodeId);
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.ownerUsername, 'alice');

  const bobApprove = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/approve`,
    headers: auth(bobToken),
  });
  assert.equal(bobApprove.statusCode, 403, bobApprove.body);

  const aliceApprove = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/approve`,
    headers: auth(aliceToken),
  });
  assert.equal(aliceApprove.statusCode, 200, aliceApprove.body);
  assert.equal((aliceApprove.json() as { node: { status?: string } }).node.status, 'approved');
  assert.equal(built.nodeManager.isOnline(nodeId), true);
  ws.terminate();
});

test('属主可拒绝自己的待审批节点；他人 403', async () => {
  const claim = await app.inject({
    method: 'POST',
    url: '/api/node-claims/ensure',
    headers: auth(aliceToken),
  });
  const claimToken = (claim.json() as { claimToken: string }).claimToken;

  const { ws, nodeId } = await connectAnon('n_alice_reject', claimToken);

  const bobReject = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/reject`,
    headers: auth(bobToken),
    payload: { reason: 'no' },
  });
  assert.equal(bobReject.statusCode, 403, bobReject.body);

  const aliceReject = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/reject`,
    headers: auth(aliceToken),
    payload: { reason: '不需要了' },
  });
  assert.equal(aliceReject.statusCode, 200, aliceReject.body);
  const rec = built.nodeManager.list().find((n) => n.nodeId === nodeId);
  assert.equal(rec?.status, 'blocked');
  ws.terminate();
});

test('纯匿名申请（无属主）仅管理员可审批', async () => {
  const { ws, nodeId } = await connectAnon('n_anon_approve');
  const pending = built.nodeManager.list().find((n) => n.nodeId === nodeId);
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.ownerUsername, undefined);

  const bobApprove = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/approve`,
    headers: auth(bobToken),
  });
  assert.equal(bobApprove.statusCode, 403, bobApprove.body);

  const adminApprove = await app.inject({
    method: 'POST',
    url: `/api/nodes/${encodeURIComponent(nodeId)}/approve`,
    headers: auth(adminToken),
  });
  assert.equal(adminApprove.statusCode, 200, adminApprove.body);
  assert.equal(built.nodeManager.isOnline(nodeId), true);
  ws.terminate();
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
