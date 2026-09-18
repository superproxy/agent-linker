import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ADMIN_USERNAME } from '@linkagent/shared';
import { hashPassword, verifyPassword, validatePassword } from '../../src/gateway/users/password.js';
import { AuthError, UserStore } from '../../src/gateway/users/store.js';
import { AuthGuard } from '../../src/gateway/users/auth.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-users-'));
}

test('hashPassword / verifyPassword：正确密码通过，错误密码拒绝，hash 带随机 salt', () => {
  const h1 = hashPassword('s3cret-pw');
  const h2 = hashPassword('s3cret-pw');
  assert.notEqual(h1, h2, '同一密码两次 hash 因 salt 不同而不同');
  assert.match(h1, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('s3cret-pw', h1), true);
  assert.equal(verifyPassword('wrong-pw', h1), false);
  assert.equal(verifyPassword('s3cret-pw', 'not-a-valid-hash'), false);
});

test('validatePassword：长度至少 8 位', () => {
  assert.equal(validatePassword('1234567'), '密码长度至少 8 位');
  assert.equal(validatePassword('12345678'), null);
});

test('ensureDefaultAdmin：空 store 随机生成 admin 密码且要求改密；已有用户时不重复创建', () => {
  const dir = tmpDir();
  const store1 = new UserStore(dir);
  const first = store1.ensureDefaultAdmin();
  assert.equal(first.created, true);
  assert.ok(first.password && first.password.length >= 8);
  const admin = store1.get(DEFAULT_ADMIN_USERNAME);
  assert.ok(admin);
  assert.equal(admin?.role, 'admin');
  assert.equal(admin?.mustChangePassword, true);
  assert.equal(verifyPassword(first.password!, admin!.passwordHash), true);
  assert.equal(store1.readInitialAdminPassword(), first.password);

  // 改密后重新打开实例，ensureDefaultAdmin 不应覆盖，且清除初始明文
  store1.setPassword(DEFAULT_ADMIN_USERNAME, 'new-pass-123', false);
  assert.equal(store1.readInitialAdminPassword(), null);
  const store2 = new UserStore(dir);
  const second = store2.ensureDefaultAdmin();
  assert.equal(second.created, false);
  assert.equal(store2.list().length, 1);
  assert.equal(verifyPassword('new-pass-123', store2.get(DEFAULT_ADMIN_USERNAME)!.passwordHash), true);
  assert.equal(store2.get(DEFAULT_ADMIN_USERNAME)?.mustChangePassword, false);
});

test('create：用户名规则、重复创建报错、默认 role=user', () => {
  const store = new UserStore(tmpDir());
  const u = store.create({ username: 'alice', password: 'password1' });
  assert.equal(u.username, 'alice');
  assert.equal(u.role, 'user');
  assert.throws(() => store.create({ username: 'alice', password: 'password1' }), /已存在/);
  assert.throws(() => store.create({ username: '../etc/x', password: 'password1' }), /用户名/);
  assert.throws(() => store.create({ username: 'a b', password: 'password1' }), /用户名/);
});

test('authenticate：成功返回用户；用户不存在与密码错统一报 AuthError（防枚举）', () => {
  const store = new UserStore(tmpDir());
  store.create({ username: 'bob', password: 'password1' });
  assert.equal(store.authenticate('bob', 'password1').username, 'bob');
  assert.throws(() => store.authenticate('bob', 'bad'), AuthError);
  assert.throws(() => store.authenticate('nobody', 'password1'), AuthError);
});

test('delete：删除用户连带清理其会话', () => {
  const store = new UserStore(tmpDir());
  store.create({ username: 'bob', password: 'password1' });
  const s = store.createSession('bob', 10_000);
  assert.ok(store.resolveSession(s.token, 10_000, false));
  store.delete('bob');
  assert.equal(store.get('bob'), null);
  assert.equal(store.resolveSession(s.token, 10_000, false), null);
  assert.throws(() => store.delete('bob'), /不存在/);
});

test('会话：TTL 过期失效；滑动续期延后过期时间', async () => {
  const store = new UserStore(tmpDir());
  store.create({ username: 'bob', password: 'password1' });
  const s = store.createSession('bob', 20);
  assert.ok(store.resolveSession(s.token, 20, false));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.resolveSession(s.token, 20, false), null, '过期会话返回 null 并被清理');

  const s2 = store.createSession('bob', 10_000);
  const first = store.resolveSession(s2.token, 10_000, false)!.expiresAt;
  const renewed = store.resolveSession(s2.token, 20_000, true)!;
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first), '滑动续期应延后过期时间');

  store.revokeSession(s2.token);
  assert.equal(store.resolveSession(s2.token, 10_000, false), null);
});

test('AuthGuard：disabled / 静态 token / 会话 / 无效凭据 四态', () => {
  const dir = tmpDir();
  const store = new UserStore(dir);
  store.ensureDefaultAdmin();
  store.create({ username: 'alice', password: 'password1', role: 'user' });
  const adminSession = store.createSession('admin', 10_000);
  const userSession = store.createSession('alice', 10_000);

  const off = new AuthGuard(store, { mode: 'open', staticToken: '', sessionTtlDays: 7 });
  assert.equal(off.checkAuth({ headers: {} }), true, 'open 模式一律放行');
  assert.equal(off.isAdmin({ headers: {} }), true);

  const guard = new AuthGuard(store, { mode: 'token', staticToken: 'static-secret', sessionTtlDays: 7 });
  assert.equal(guard.checkAuth({ headers: {} }), false, '无凭据拒绝');
  assert.equal(guard.checkAuth({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(guard.checkAuth({ headers: { authorization: 'Bearer static-secret' } }), true);
  assert.equal(guard.checkAuth({ headers: { authorization: `Bearer ${adminSession.token}` } }), true);
  assert.equal(guard.checkAuth({ headers: { authorization: `Bearer ${userSession.token}` } }), true);

  // 管理员判定：静态 token / admin 会话通过，普通用户会话拒绝
  assert.equal(guard.isAdmin({ headers: { authorization: 'Bearer static-secret' } }), true);
  assert.equal(guard.isAdmin({ headers: { authorization: `Bearer ${adminSession.token}` } }), true);
  assert.equal(guard.isAdmin({ headers: { authorization: `Bearer ${userSession.token}` } }), false);

  // sessionUser 仅会话态返回用户
  assert.equal(guard.sessionUser({ headers: { authorization: `Bearer ${userSession.token}` } })?.username, 'alice');
  assert.equal(guard.sessionUser({ headers: { authorization: 'Bearer static-secret' } }), null);
});
