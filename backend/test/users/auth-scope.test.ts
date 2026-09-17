import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthGuard, type TaskKeyResolver } from '../../src/gateway/users/auth.js';
import { UserStore } from '../../src/gateway/users/store.js';
import { ChannelTokenStore } from '../../src/gateway/users/channel-token-store.js';
import { PersonalTokenStore } from '../../src/gateway/users/personal-token-store.js';

const req = (authorization?: string, ip?: string) => ({
  headers: authorization ? { authorization } : {},
  ...(ip ? { ip } : {}),
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-authscope-'));
  const users = new UserStore(dir);
  users.ensureDefaultAdmin();
  const channelTokens = new ChannelTokenStore(dir);
  const personalTokens = new PersonalTokenStore(dir);

  // 两个任务 key：t_enabled 启用、t_disabled 已停用
  const tasks = new Map<string, { id: string; keyEnabled?: boolean }>([
    ['k_enabled', { id: 'taskA', keyEnabled: true }],
    ['k_disabled', { id: 'taskB', keyEnabled: false }],
  ]);
  const taskKeys: TaskKeyResolver = {
    findByKey: (key) => {
      const t = tasks.get(key);
      return t ? { channel: 'weixin', userId: 'owner-1', task: { id: t.id, key, keyEnabled: t.keyEnabled } } : undefined;
    },
  };

  const guard = new AuthGuard(users, {
    mode: 'token',
    staticToken: 'static-secret',
    sessionTtlDays: 7,
    taskKeys,
    channelTokens,
    personalTokens,
  });
  return { dir, users, channelTokens, personalTokens, guard };
}

test('静态 token → token 态；无凭据 → none；checkAuth 仅放行 token/session', () => {
  const { guard } = setup();
  assert.equal(guard.resolve(req('Bearer static-secret')).status, 'token');
  assert.equal(guard.resolve(req()).status, 'none');
  assert.equal(guard.checkAuth(req('Bearer static-secret')), true);
  assert.equal(guard.checkAuth(req()), false);
});

test('resolveChat：Bearer 任务 key → task 态并锁定任务', () => {
  const { guard } = setup();
  const s = guard.resolveChat(req('Bearer k_enabled'));
  assert.equal(s.status, 'task');
  if (s.status === 'task') {
    assert.equal(s.taskId, 'taskA');
    assert.equal(s.channel, 'weixin');
    assert.equal(s.userId, 'owner-1');
    assert.equal(s.taskKey, 'k_enabled');
  }
});

test('resolveChat：停用的任务 key 视为无效凭据（none）', () => {
  const { guard } = setup();
  assert.equal(guard.resolveChat(req('Bearer k_disabled')).status, 'none');
});

test('resolveChat：无常规凭据但 body.taskKey 命中 → task 态（任务 key 充当凭据直连）', () => {
  const { guard } = setup();
  const s = guard.resolveChat(req(), { taskKey: 'k_enabled' });
  assert.equal(s.status, 'task');
});

test('resolveChat：body.taskKey 已停用 → none；不存在 → none', () => {
  const { guard } = setup();
  assert.equal(guard.resolveChat(req(), { taskKey: 'k_disabled' }).status, 'none');
  assert.equal(guard.resolveChat(req(), { taskKey: 'k_nope' }).status, 'none');
});

test('任务 key 不能用于常规管理接口（resolve/checkAuth 不放行）', () => {
  const { guard } = setup();
  // 普通 resolve 不识别任务 key（仅 resolveChat 识别）
  assert.equal(guard.resolve(req('Bearer k_enabled')).status, 'none');
  assert.equal(guard.checkAuth(req('Bearer k_enabled')), false);
});

test('渠道用户 token → channelUser 态，携带其 channel/userId；checkAuth 不放行管理接口', () => {
  const { guard, channelTokens } = setup();
  const rec = channelTokens.ensure('weixin', 'wx-user-9');
  const s = guard.resolve(req(`Bearer ${rec.token}`));
  assert.equal(s.status, 'channelUser');
  if (s.status === 'channelUser') {
    assert.equal(s.channel, 'weixin');
    assert.equal(s.userId, 'wx-user-9');
  }
  // 作用域凭据不能访问管理接口
  assert.equal(guard.checkAuth(req(`Bearer ${rec.token}`)), false);
  // 但 resolveChat 接受（/v1 可用）
  assert.equal(guard.resolveChat(req(`Bearer ${rec.token}`)).status, 'channelUser');
});

test('吊销后的渠道 token 立即失效', () => {
  const { guard, channelTokens } = setup();
  const rec = channelTokens.ensure('weixin', 'wx-revoke');
  channelTokens.revoke(rec.token);
  assert.equal(guard.resolve(req(`Bearer ${rec.token}`)).status, 'none');
});

test('个人 token → personal 态，等同账号本人：checkAuth/sessionUser 放行，resolveChat 可用', () => {
  const { guard, personalTokens } = setup();
  const rec = personalTokens.ensure('admin');
  const s = guard.resolve(req(`Bearer ${rec.token}`));
  assert.equal(s.status, 'personal');
  if (s.status === 'personal') {
    assert.equal(s.user.username, 'admin');
  }
  // 与会话同等：可访问管理接口、可取登录用户、/v1 直连
  assert.equal(guard.checkAuth(req(`Bearer ${rec.token}`)), true);
  assert.equal(guard.sessionUser(req(`Bearer ${rec.token}`))?.username, 'admin');
  assert.equal(guard.resolveChat(req(`Bearer ${rec.token}`)).status, 'personal');
  // admin 角色 → 管理员操作放行
  assert.equal(guard.isAdmin(req(`Bearer ${rec.token}`)), true);
});

test('个人 token：账号被删除后凭据立即失效', () => {
  const { dir, personalTokens } = setup();
  const rec = personalTokens.ensure('ghost');
  // ghost 从未在 UserStore 中存在 → resolve 拿不到 user → none
  const users = new UserStore(dir);
  const guard = new AuthGuard(users, {
    mode: 'token',
    staticToken: 'static-secret',
    sessionTtlDays: 7,
    personalTokens,
  });
  assert.equal(guard.resolve(req(`Bearer ${rec.token}`)).status, 'none');
});

test('吊销后的个人 token 立即失效', () => {
  const { guard, personalTokens } = setup();
  const rec = personalTokens.ensure('admin');
  personalTokens.revokeForUser('admin');
  assert.equal(guard.resolve(req(`Bearer ${rec.token}`)).status, 'none');
});

test('未开启鉴权：一切凭据态为 disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-authscope-off-'));
  const users = new UserStore(dir);
  const channelTokens = new ChannelTokenStore(dir);
  const guard = new AuthGuard(users, {
    mode: 'open',
    staticToken: '',
    sessionTtlDays: 7,
    channelTokens,
  });
  assert.equal(guard.resolve(req()).status, 'disabled');
  assert.equal(guard.resolveChat(req()).status, 'disabled');
  assert.equal(guard.checkAuth(req()), true);
});

test('local 模式：回环无凭据 → local 默认用户；gateway token → local；非回环无 token → none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-authscope-local-'));
  const users = new UserStore(dir);
  const guard = new AuthGuard(users, {
    mode: 'local',
    staticToken: 'gw-secret',
    sessionTtlDays: 7,
  });

  // 回环浏览器免登录
  const loop = guard.resolve(req(undefined, '127.0.0.1'));
  assert.equal(loop.status, 'local');
  if (loop.status === 'local') {
    assert.equal(loop.user.username, 'local');
    assert.equal(loop.user.role, 'admin');
  }
  assert.equal(guard.checkAuth(req(undefined, '::1')), true);
  assert.equal(guard.isAdmin(req(undefined, '127.0.0.1')), true);
  assert.equal(guard.sessionUser(req(undefined, '127.0.0.1'))?.username, 'local');

  // gateway token 同样映射为默认用户（任意来源）
  assert.equal(guard.resolve(req('Bearer gw-secret', '10.0.0.9')).status, 'local');

  // 非回环且无 token → 拒绝
  assert.equal(guard.resolve(req(undefined, '10.0.0.9')).status, 'none');
  assert.equal(guard.checkAuth(req(undefined, '10.0.0.9')), false);
});
