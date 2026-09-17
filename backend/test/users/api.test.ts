import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

// 每个测试文件用独立运行态目录，避免默认 admin 落盘污染仓库 .runtime-state
const runtimeHome = mkdtempSync(join(tmpdir(), 'linkagent-auth-home-'));

let built: Built;
let app: FastifyInstance;

before(async () => {
  process.env.LINKAGENT_HOME = runtimeHome;
  built = await buildServer({
    configPath: 'test/fixtures/gateway.auth.yaml',
    definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] as never,
  });
  app = built.app;
});

after(async () => {
  await built.pluginManager?.dispose().catch(() => {});
  await built.manager.dispose().catch(() => {});
  await app.close().catch(() => {});
  delete process.env.LINKAGENT_HOME;
});

const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

test('默认 admin/admin123 可登录，返回会话 token 且标记 mustChangePassword', async () => {
  const res = await login('admin', 'admin123');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { token: string; user: { username: string; role: string; mustChangePassword: boolean } };
  assert.ok(body.token.length >= 32);
  assert.equal(body.user.username, 'admin');
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.mustChangePassword, true);
});

test('错误密码 / 不存在用户统一 401 invalid_credentials', async () => {
  const bad = await login('admin', 'wrong-password');
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'invalid_credentials');
  const nobody = await login('nobody', 'whatever-123');
  assert.equal(nobody.statusCode, 401);
  assert.equal(nobody.json().error.code, 'invalid_credentials');
});

test('未携带凭据访问受保护接口 → 401；静态 token 与会话 token 均可访问', async () => {
  const noAuth = await app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(noAuth.statusCode, 401);

  const staticAuth = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer test-static-token' } });
  assert.equal(staticAuth.statusCode, 200);

  const sess = await login('admin', 'admin123');
  const token = (sess.json() as { token: string }).token;
  const sessionAuth = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${token}` } });
  assert.equal(sessionAuth.statusCode, 200);
});

test('GET /api/auth/me：无凭据 401；会话返回用户；静态 token 返回 tokenAuth', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode, 401);

  const token = ((await login('admin', 'admin123')).json() as { token: string }).token;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  const meBody = me.json() as { authEnabled: boolean; user: { username: string } | null; tokenAuth?: boolean };
  assert.equal(meBody.authEnabled, true);
  assert.equal(meBody.user?.username, 'admin');

  const tm = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer test-static-token' } });
  const tmBody = tm.json() as { tokenAuth?: boolean; user: null };
  assert.equal(tmBody.tokenAuth, true);
  assert.equal(tmBody.user, null);
});

test('改密：原密码错误 401；弱密码 400；成功后用新密码登录、mustChangePassword 解除', async () => {
  const token = ((await login('admin', 'admin123')).json() as { token: string }).token;
  const change = (oldPassword: string, newPassword: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword, newPassword },
    });

  assert.equal((await change('wrong-old', 'new-pass-123')).statusCode, 401);
  assert.equal((await change('admin123', 'short')).statusCode, 400);
  assert.equal((await change('admin123', 'admin123')).statusCode, 400);

  const ok = await change('admin123', 'new-pass-123');
  assert.equal(ok.statusCode, 200, ok.body);

  // 旧密码登录失败，新密码成功
  assert.equal((await login('admin', 'admin123')).statusCode, 401);
  const relogin = await login('admin', 'new-pass-123');
  assert.equal(relogin.statusCode, 200);
  assert.equal((relogin.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword, false);
});

test('用户管理：admin 建用户/列表/重置密码/删除；普通用户不能管理；禁止删自己和最后一个 admin', async () => {
  const adminToken = ((await login('admin', 'new-pass-123')).json() as { token: string }).token;
  const auth = { authorization: `Bearer ${adminToken}` };

  // 新建普通用户
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: auth,
    payload: { username: 'alice', password: 'init-pass-1', displayName: 'Alice' },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal((created.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword, true);

  // 重复用户名 409；非法用户名 / 弱密码 400
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { username: 'alice', password: 'another-123' } })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { username: 'bad name', password: 'another-123' } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { username: 'carol', password: 'short' } })).statusCode,
    400,
  );

  // 列表含 admin + alice，且不泄漏密码哈希
  const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth });
  const users = (list.json() as { users: Record<string, unknown>[] }).users;
  assert.deepEqual(users.map((u) => u.username).sort(), ['admin', 'alice']);
  assert.ok(users.every((u) => !('passwordHash' in u)));

  // 普通用户登录后不能访问用户管理
  const aliceToken = ((await login('alice', 'init-pass-1')).json() as { token: string }).token;
  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${aliceToken}` } });
  assert.equal(forbidden.statusCode, 403);

  // admin 重置 alice 密码
  const reset = await app.inject({
    method: 'POST',
    url: '/api/admin/users/alice/reset-password',
    headers: auth,
    payload: { newPassword: 'reset-pass-1' },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await login('alice', 'init-pass-1')).statusCode, 401);
  assert.equal((await login('alice', 'reset-pass-1')).statusCode, 200);

  // 禁止删除自己；禁止删除最后一个 admin
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/users/admin', headers: auth })).statusCode, 400);

  // 建第二个 admin 后可删除第一个（再建一个 admin 验证 last-admin 规则解除）
  const mk2 = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: auth,
    payload: { username: 'root2', password: 'root-pass-123', role: 'admin' },
  });
  assert.equal(mk2.statusCode, 200, mk2.body);
  // 当前登录的是 admin，删 root2（非自己，且仍有 admin 剩余）→ 成功
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/users/root2', headers: auth })).statusCode, 200);

  // 删除 alice → 列表只剩 admin
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/users/alice', headers: auth })).statusCode, 200);
  const after = (await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth })).json() as { users: unknown[] };
  assert.equal(after.users.length, 1);
});

test('登出后会话 token 立即失效', async () => {
  const token = ((await login('admin', 'new-pass-123')).json() as { token: string }).token;
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode,
    200,
  );
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token}` } });
  assert.equal(out.statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode,
    401,
  );
});

test('未开启鉴权模式：登录接口返回 400 auth_disabled（登录无意义）', async () => {
  process.env.LINKAGENT_HOME = mkdtempSync(join(tmpdir(), 'linkagent-noauth-home-'));
  const b2 = await buildServer({
    configPath: 'test/fixtures/gateway.test.yaml',
    definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] as never,
  });
  try {
    const res = await b2.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'x' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'auth_disabled');
    // 未开启鉴权时受保护接口直接放行
    assert.equal((await b2.app.inject({ method: 'GET', url: '/api/agents' })).statusCode, 200);
  } finally {
    await b2.manager.dispose().catch(() => {});
    await b2.app.close().catch(() => {});
    process.env.LINKAGENT_HOME = runtimeHome;
  }
});
