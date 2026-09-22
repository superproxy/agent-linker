import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

const runtimeHome = mkdtempSync(join(tmpdir(), 'linkagent-rbac-home-'));

let built: Built;
let app: FastifyInstance;
let adminToken = '';
let userToken = '';

before(async () => {
  process.env.LINKAGENT_HOME = runtimeHome;
  built = await buildServer({
    configPath: 'test/fixtures/gateway.auth.yaml',
    definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] as never,
  });
  app = built.app;
  const boot = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1' });
  const initial = (boot.json() as { initialAdmin?: { password: string } }).initialAdmin?.password;
  assert.ok(initial);
  adminToken = ((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: initial },
  })).json() as { token: string }).token;

  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: 'alice', password: 'init-pass-1', displayName: 'Alice' },
  });
  assert.equal(created.statusCode, 200, created.body);
  userToken = ((await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'init-pass-1' },
  })).json() as { token: string }).token;
});

after(async () => {
  await built.pluginManager?.dispose().catch(() => {});
  await built.manager.dispose().catch(() => {});
  await app.close().catch(() => {});
  delete process.env.LINKAGENT_HOME;
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

test('普通用户不能读本机 agent；任务/渠道用户仅自己的空间', async () => {
  const forbidden = ['/api/agents', '/api/agents/catalog'];
  for (const url of forbidden) {
    const res = await app.inject({ method: 'GET', url, headers: auth(userToken) });
    assert.equal(res.statusCode, 403, `${url} 应对普通用户 403，实际 ${res.statusCode} ${res.body}`);
  }
  const ownAgents = await app.inject({ method: 'GET', url: '/api/agents/by-node', headers: auth(userToken) });
  assert.equal(ownAgents.statusCode, 200, ownAgents.body);
  assert.equal((ownAgents.json() as { local?: unknown }).local, undefined);
  const wx = await app.inject({ method: 'GET', url: '/api/weixin/status', headers: auth(userToken) });
  assert.equal(wx.statusCode, 200, wx.body);
  const wxBody = wx.json() as { bindAccountId?: string; accounts: { id: string }[] };
  assert.equal(wxBody.bindAccountId, 'alice');
  assert.ok(!wxBody.accounts.some((a) => a.id === 'admin'));

  const seeded = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: auth(adminToken),
    payload: { channel: 'weixin', userId: 'wx_admin_peer', name: 'admin微信任务', ownerUsername: 'admin' },
  });
  assert.equal(seeded.statusCode, 200, seeded.body);

  const aliceAll = await app.inject({ method: 'GET', url: '/api/tasks/all', headers: auth(userToken) });
  assert.equal(aliceAll.statusCode, 200, aliceAll.body);
  const aliceUsers = (
    aliceAll.json() as { users: Array<{ ownerUsername?: string; channel: string; userId: string; tasks: { name: string }[] }> }
  ).users;
  assert.ok(aliceUsers.every((u) => u.ownerUsername === 'alice'));
  assert.ok(!aliceUsers.some((u) => u.tasks.some((t) => t.name === 'admin微信任务')));

  const aliceUsersList = await app.inject({ method: 'GET', url: '/api/users', headers: auth(userToken) });
  assert.equal(aliceUsersList.statusCode, 200, aliceUsersList.body);
  const listed = (aliceUsersList.json() as { users: Array<{ ownerUsername?: string }> }).users;
  assert.ok(listed.every((u) => u.ownerUsername === 'alice'));

  for (const url of ['/api/tasks/all', '/api/users', '/api/agents']) {
    const res = await app.inject({ method: 'GET', url, headers: auth(adminToken) });
    assert.equal(res.statusCode, 200, `${url} 应对管理员 200，实际 ${res.statusCode} ${res.body}`);
  }
  const adminAll = (
    (await app.inject({ method: 'GET', url: '/api/tasks/all', headers: auth(adminToken) })).json() as {
      users: Array<{ ownerUsername?: string; userId: string; tasks: { name: string }[] }>;
    }
  ).users;
  assert.ok(adminAll.every((u) => u.ownerUsername === 'admin' && u.userId === 'admin'));
  assert.ok(adminAll.some((u) => u.tasks.some((t) => t.name === 'admin微信任务')));
  assert.ok(!adminAll.some((u) => u.ownerUsername === 'alice'));
});

test('普通用户可颁发 nt_ 机器凭证（非 pat_ / 登录会话）', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/node-tokens',
    headers: auth(userToken),
    payload: { label: 'alice-node' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { token: string; tokenPreview: string };
  assert.ok(body.token.startsWith('nt_'), body.token);
  assert.ok(body.tokenPreview.includes('…'));
});

test('普通用户节点列表不含本机；by-node / node-agents 不带 local', async () => {
  const nodes = await app.inject({ method: 'GET', url: '/api/nodes', headers: auth(userToken) });
  assert.equal(nodes.statusCode, 200, nodes.body);
  const listed = (nodes.json() as { nodes: { nodeId: string }[] }).nodes;
  assert.ok(!listed.some((n) => n.nodeId === 'local'), '普通用户不应看到本机节点');

  const adminNodes = await app.inject({ method: 'GET', url: '/api/nodes', headers: auth(adminToken) });
  assert.ok((adminNodes.json() as { nodes: { nodeId: string }[] }).nodes.some((n) => n.nodeId === 'local'));

  const byNode = await app.inject({ method: 'GET', url: '/api/agents/by-node', headers: auth(userToken) });
  assert.equal(byNode.statusCode, 200, byNode.body);
  const byBody = byNode.json() as { local?: unknown };
  assert.equal(byBody.local, undefined);

  const na = await app.inject({ method: 'GET', url: '/api/node-agents', headers: auth(userToken) });
  assert.equal(na.statusCode, 200, na.body);
  assert.equal((na.json() as { local?: unknown }).local, undefined);
});
