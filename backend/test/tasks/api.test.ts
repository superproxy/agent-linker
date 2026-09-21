import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { decideTaskRouting } from '../../src/gateway/tasks/api.js';
import { persistDefaultTaskAgentId, loadGatewayConfig } from '../../src/gateway/config.js';

function freshService(): TaskService {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  return new TaskService({ store: createJsonStore(dir) });
}

test('无 channel/userId → legacy（原 model+sessionKey 路径）', () => {
  const svc = freshService();
  const d = decideTaskRouting(svc, { text: '你好', channel: '', userId: '' });
  assert.equal(d.kind, 'legacy');
});

test('命令 → command，返回文本，状态变更落盘', () => {
  const svc = freshService();
  const d = decideTaskRouting(svc, { text: '/task new 写方案 pi', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'command');
  assert.ok(d.text!.includes('写方案'));
  // 落盘持久化：重新 load 可见
  const state = svc.load('weixin', 'wx_1');
  assert.equal(state.tasks.length, 2);
});

test('普通消息 → chat，解析激活任务 agent+task，sessionKey 编码任务', () => {
  const svc = freshService();
  svc.load('weixin', 'wx_1');
  const d = decideTaskRouting(svc, { text: '帮我写方案', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'pi');
  assert.equal(d.taskId, 'default');
  assert.equal(d.sessionKey, 'weixin:wx_1:task:default');
});

test('带 ownerUsername 的会话 key 前缀隔离；同 peer 不同 owner 不串文件', () => {
  const svc = freshService();
  const alice = svc.load('weixin', 'wx_same', 'alice');
  svc.createTask(alice, 'alice任务', 'pi');
  const bob = svc.load('weixin', 'wx_same', 'bob');
  assert.equal(bob.tasks.length, 1);
  assert.equal(alice.tasks.length, 2);
  const d = decideTaskRouting(svc, {
    text: '你好',
    channel: 'weixin',
    userId: 'wx_same',
    ownerUsername: 'alice',
  });
  assert.equal(d.kind, 'chat');
  if (d.kind === 'chat') {
    assert.ok(d.sessionKey.startsWith('alice:weixin:wx_same:task:'));
    assert.notEqual(d.sessionKey, 'weixin:wx_same:task:default');
  }
  const db = decideTaskRouting(svc, {
    text: '你好',
    channel: 'weixin',
    userId: 'wx_same',
    ownerUsername: 'bob',
  });
  assert.equal(db.kind, 'chat');
  if (db.kind === 'chat') assert.equal(db.sessionKey, 'bob:weixin:wx_same:task:default');
  assert.equal(svc.load('web', 'alice', 'alice').tasks.some((t) => t.name === 'alice任务'), true);
  assert.equal(svc.load('web', 'bob', 'bob').tasks.length, 1);
});

test('换绑微信时重签登录空间任务 key，并覆盖无归属旧 weixin 文件', () => {
  const svc = freshService();
  const space = svc.ensureLoginSpace('alice');
  const old = space.tasks[0]?.key;
  assert.ok(old);
  const leftover = svc.load('weixin', 'wx_old');
  const leftoverKey = leftover.tasks[0]?.key;
  const after = svc.rotateKeysOnWeixinBind('alice');
  assert.notEqual(after.tasks[0]?.key, old);
  assert.notEqual(svc.load('weixin', 'wx_old').tasks[0]?.key, leftoverKey);
});

test('weixin + owner 共用登录任务空间；sessionKey 仍按联系人隔离', () => {
  const svc = freshService();
  const created = decideTaskRouting(svc, {
    text: '/task new 共享任务 pi',
    channel: 'weixin',
    userId: 'wx_a',
    ownerUsername: 'alice',
  });
  assert.equal(created.kind, 'command');
  const space = svc.load('web', 'alice', 'alice');
  assert.ok(space.tasks.some((t) => t.name === '共享任务'));
  const peerB = decideTaskRouting(svc, {
    text: '你好',
    channel: 'weixin',
    userId: 'wx_b',
    ownerUsername: 'alice',
  });
  assert.equal(peerB.kind, 'chat');
  if (peerB.kind === 'chat') {
    assert.equal(peerB.taskId, space.activeTaskId);
    assert.ok(peerB.sessionKey.startsWith('alice:weixin:wx_b:task:'));
  }
});

test('普通消息带 agent/task 参数 → 覆盖路由', () => {
  const svc = freshService();
  svc.load('weixin', 'wx_1');
  const d = decideTaskRouting(svc, {
    text: '继续排查',
    channel: 'weixin',
    userId: 'wx_1',
    agent: 'pi',
    task: 't_x',
  });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'pi');
  assert.equal(d.taskId, 't_x');
  assert.equal(d.sessionKey, 'weixin:wx_1:task:t_x');
});

test('任务绑定 agent+cwd：微信普通消息路由到对应 ACP agent 与工作目录', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '股票分析', 'pi', undefined, '/tmp/wx-stock');
  // 切到该任务
  svc.handleCommand(state, `/task use ${t.id}`);
  // 微信普通消息 → chat，agent/cwd 均由任务决定
  const d = decideTaskRouting(svc, { text: '帮我分析下股票', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'pi');
  assert.equal(d.taskId, t.id);
  assert.equal(d.cwd, '/tmp/wx-stock');
  assert.equal(d.sessionKey, `weixin:wx_1:task:${t.id}`);
});

test('切回 default 任务：回落 defaultAgentId，无任务 cwd', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  svc.createTask(state, '股票分析', 'pi', undefined, '/tmp/wx-stock');
  svc.handleCommand(state, '/task default');
  const d = decideTaskRouting(svc, { text: '你好', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'pi'); // 默认任务固定本机 pi
  assert.equal(d.taskId, 'default');
  assert.equal(d.cwd, undefined);
});

test('decideTaskRouting: taskKey 单 key 直连路由，sessionKey 与三元素一致', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '股票', 'pi');
  // key 路由：无需 channel/userId 三元素
  const d = decideTaskRouting(svc, { text: '继续', taskKey: t.key });
  assert.equal(d.kind, 'chat');
  assert.equal(d.taskId, t.id);
  assert.equal(d.agentId, 'pi');
  assert.equal(d.sessionKey, `weixin:wx_1:task:${t.id}`);
  // 与三元素路由派生同一 sessionKey（会话/记忆互通）
  const d3 = decideTaskRouting(svc, { text: '继续', channel: 'weixin', userId: 'wx_1', task: t.id });
  assert.equal(d3.kind, 'chat');
  assert.equal(d3.sessionKey, d.sessionKey);
  // 命令同样作用于反查出的用户状态
  const dc = decideTaskRouting(svc, { text: '/task list', taskKey: t.key });
  assert.equal(dc.kind, 'command');
  assert.ok(dc.text!.includes(t.key));
  // key 不存在 → notfound
  const dn = decideTaskRouting(svc, { text: 'hi', taskKey: 'k_nope' });
  assert.equal(dn.kind, 'notfound');
  // key 停用 → disabled（鉴权拒绝；三元素路由不受影响）
  svc.setKeyEnabled(state, t.id, false);
  const dd = decideTaskRouting(svc, { text: '继续', taskKey: t.key });
  assert.equal(dd.kind, 'disabled');
  const d3b = decideTaskRouting(svc, { text: '继续', channel: 'weixin', userId: 'wx_1', task: t.id });
  assert.equal(d3b.kind, 'chat');
});

import Fastify from 'fastify';
import { registerTaskApi } from '../../src/gateway/tasks/api.js';
import type { FastifyInstance } from 'fastify';

async function freshApp(): Promise<FastifyInstance> {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(app, svc, () => true); // 测试不鉴权
  await app.ready();
  return app;
}

test('/api/tasks: 首次 GET 返回默认任务（懒初始化落盘）', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.activeTaskId, 'default');
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].agentId, 'pi');
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: POST 新建 + PATCH activate + DELETE', async () => {
  const app = await freshApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '写方案', agentId: 'pi' },
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();
    assert.equal(task.agentId, 'pi');
    assert.ok(task.id.startsWith('t_'));

    const list = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(list.json().activeTaskId, task.id); // 新建即激活

    const act = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/activate`,
      payload: { channel: 'weixin', userId: 'wx_9' },
    });
    assert.equal(act.statusCode, 200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}?channel=weixin&userId=wx_9`,
    });
    assert.equal(del.statusCode, 200);
    const list2 = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(list2.json().tasks.length, 1);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: PATCH /agent 修改任务绑定 agent', async () => {
  const app = await freshApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '股票', agentId: 'opencode' },
    });
    const task = created.json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/agent`,
      payload: { channel: 'weixin', userId: 'wx_9', agentId: 'pi' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.agentId, 'pi');

    // 缺 agentId → 400
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/agent`,
      payload: { channel: 'weixin', userId: 'wx_9' },
    });
    assert.equal(bad.statusCode, 400);

    // 不存在 → 404
    const nf = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/nope/agent',
      payload: { channel: 'weixin', userId: 'wx_9', agentId: 'pi' },
    });
    assert.equal(nf.statusCode, 404);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: 删除 default 允许，列表可空', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/default?channel=weixin&userId=wx_9',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { tasks: unknown[]; activeTaskId: string };
    assert.equal(body.tasks.length, 0);
    assert.equal(body.activeTaskId, '');
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks DELETE: 渠道用户凭据可删自己的任务；越权/无凭据 401', async () => {
  const svc = freshService();
  const app = Fastify();
  // 管理凭据（Bearer admin）可全量操作；渠道用户凭据 ct_wx_9 只能删自己
  registerTaskApi(
    app,
    svc,
    (req) => (req.headers as Record<string, string | undefined>).authorization === 'Bearer admin',
    undefined,
    (req) => {
      const h = (req.headers as Record<string, string | undefined>).authorization ?? '';
      return h === 'Bearer ct_wx_9' ? { channel: 'weixin', userId: 'wx_9' } : null;
    },
  );
  await app.ready();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '自己的', agentId: 'pi' },
      headers: { authorization: 'Bearer admin' },
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();

    // 持 wx_9 凭据：可删自己的任务
    const own = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}?channel=weixin&userId=wx_9`,
      headers: { authorization: 'Bearer ct_wx_9' },
    });
    assert.equal(own.statusCode, 200);
    const list = await app.inject({
      method: 'GET',
      url: '/api/tasks?channel=weixin&userId=wx_9',
      headers: { authorization: 'Bearer admin' },
    });
    assert.equal(list.json().tasks.length, 1); // 只剩 default

    // 越权：wx_9 凭据删他人（wx_2）任务 → 401，任务不受影响
    const other = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_2', name: '别人的', agentId: 'pi' },
      headers: { authorization: 'Bearer admin' },
    });
    const otherTask = other.json();
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${otherTask.id}?channel=weixin&userId=wx_2`,
      headers: { authorization: 'Bearer ct_wx_9' },
    });
    assert.equal(forbidden.statusCode, 401);
    const otherList = await app.inject({
      method: 'GET',
      url: '/api/tasks?channel=weixin&userId=wx_2',
      headers: { authorization: 'Bearer admin' },
    });
    assert.equal(otherList.json().tasks.find((t: { id: string }) => t.id === otherTask.id).name, '别人的');

    // 无任何凭据 → 401
    const anon = await app.inject({ method: 'DELETE', url: '/api/tasks/default?channel=weixin&userId=wx_9' });
    assert.equal(anon.statusCode, 401);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks/all: 返回全部登录用户任务空间（管理后台任务页）', async () => {
  const app = await freshApp();
  try {
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'web', userId: 'alice', name: '方案A', agentId: 'pi', ownerUsername: 'alice' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'web', userId: 'bob', name: '周报', ownerUsername: 'bob' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/all' });
    assert.equal(res.statusCode, 200);
    const users = res.json().users;
    assert.ok(users.length >= 2);
    assert.ok(users.every((u: { channel: string }) => u.channel === 'web'));

    const u1 = users.find((u: { userId: string }) => u.userId === 'alice');
    assert.ok(u1);
    assert.equal(u1.tasks.length, 2); // default + 方案A
    assert.equal(u1.tasks.find((t: { name: string }) => t.name === '方案A').agentId, 'pi');

    const u2 = users.find((u: { userId: string }) => u.userId === 'bob');
    assert.ok(u2);
    const created = u2.tasks.find((t: { name: string }) => t.name === '周报');
    assert.ok(created);
    assert.equal(u2.activeTaskId, created.id);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks/all: 开箱状态返回空列表，不凭空造登录空间', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/all' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().users, []);

    // 渠道终端列表页同样为空（GET 不应产生建档副作用）
    const ures = await app.inject({ method: 'GET', url: '/api/users' });
    assert.deepEqual(ures.json().users, []);

    // 幂等：再次请求仍为空，确认读取接口不落盘
    const again = await app.inject({ method: 'GET', url: '/api/tasks/all' });
    assert.deepEqual(again.json().users, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('非管理员：任务汇总/渠道用户/改任务 403；ct_ 作用域读取仍走 checkAuth=false 路径', async () => {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(app, svc, () => true, { isAdmin: () => false });
  await app.ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/all' })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/users' })).statusCode, 403);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_1' })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: { channel: 'weixin', userId: 'wx_1', name: '越权' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close().catch(() => {});
  }
});

test('登录用户只能看到自己的任务空间；管理员可见全部', async () => {
  const svc = freshService();
  svc.createTask(svc.load('weixin', 'wx_same', 'alice'), 'alice任务', 'opencode');
  svc.createTask(svc.load('weixin', 'wx_same', 'bob'), 'bob任务', 'pi');
  const app = Fastify();
  registerTaskApi(app, svc, () => true, {
    isAdmin: (req) => req.headers['x-user'] === 'admin',
    sessionUser: (req) => {
      const u = req.headers['x-user'];
      return typeof u === 'string' ? { username: u } : null;
    },
  });
  await app.ready();
  try {
    const alice = await app.inject({ method: 'GET', url: '/api/tasks/all', headers: { 'x-user': 'alice' } });
    assert.equal(alice.statusCode, 200);
    const aliceUsers = (
      alice.json() as {
        users: Array<{ ownerUsername?: string; channel: string; userId: string; tasks: { name: string }[] }>;
      }
    ).users;
    assert.ok(aliceUsers.every((u) => u.ownerUsername === 'alice' && u.channel === 'web' && u.userId === 'alice'));
    assert.ok(aliceUsers.some((u) => u.tasks.some((t) => t.name === 'alice任务')));
    assert.ok(!aliceUsers.some((u) => u.tasks.some((t) => t.name === 'bob任务')));

    const bob = await app.inject({ method: 'GET', url: '/api/tasks/all', headers: { 'x-user': 'bob' } });
    const bobUsers = (bob.json() as { users: Array<{ ownerUsername?: string; tasks: { name: string }[] }> }).users;
    assert.ok(bobUsers.every((u) => u.ownerUsername === 'bob'));
    assert.ok(bobUsers.some((u) => u.tasks.some((t) => t.name === 'bob任务')));
    assert.ok(!bobUsers.some((u) => u.tasks.some((t) => t.name === 'alice任务')));

    const admin = await app.inject({ method: 'GET', url: '/api/tasks/all', headers: { 'x-user': 'admin' } });
    const adminUsers = (admin.json() as { users: Array<{ tasks: { name: string }[] }> }).users;
    assert.ok(adminUsers.some((u) => u.tasks.some((t) => t.name === 'alice任务')));
    assert.ok(adminUsers.some((u) => u.tasks.some((t) => t.name === 'bob任务')));
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: POST 自动生成 key 且返回；自定义 key 成功、重复/非法 400', async () => {
  const app = await freshApp();
  try {
    const auto = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '自动' },
    });
    assert.equal(auto.statusCode, 200);
    assert.ok(auto.json().key.startsWith('k_'));

    const custom = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '分享', key: 'share-1' },
    });
    assert.equal(custom.statusCode, 200);
    assert.equal(custom.json().key, 'share-1');

    const dup = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '撞 key', key: 'share-1' },
    });
    assert.equal(dup.statusCode, 400);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '坏 key', key: 'a b' },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close().catch(() => {});
  }
});

test('GET /api/tasks/by-key/:key 反查任务与归属；不存在 404', async () => {
  const app = await freshApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '分享', agentId: 'pi' },
    });
    const task = created.json();
    const res = await app.inject({ method: 'GET', url: `/api/tasks/by-key/${task.key}` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.channel, 'weixin');
    assert.equal(body.userId, 'wx_9');
    assert.equal(body.task.id, task.id);
    assert.equal(body.task.key, task.key);

    const nf = await app.inject({ method: 'GET', url: '/api/tasks/by-key/k_nope' });
    assert.equal(nf.statusCode, 404);
  } finally {
    await app.close().catch(() => {});
  }
});

test('PATCH /api/tasks/:taskId keyEnabled 停用/启用；by-key 反查带状态', async () => {
  const app = await freshApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '分享', agentId: 'pi' },
    });
    const task = created.json();
    assert.equal(task.keyEnabled, true);

    // 停用
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { channel: 'weixin', userId: 'wx_9', keyEnabled: false },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().task.keyEnabled, false);

    // by-key 反查能看到停用状态
    const byKey = await app.inject({ method: 'GET', url: `/api/tasks/by-key/${task.key}` });
    assert.equal(byKey.statusCode, 200);
    assert.equal(byKey.json().task.keyEnabled, false);

    // 重新启用
    const on = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { channel: 'weixin', userId: 'wx_9', keyEnabled: true },
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().task.keyEnabled, true);

    // 只传 keyEnabled 也可（不必带 name）
    const onlyKey = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { channel: 'weixin', userId: 'wx_9', keyEnabled: false },
    });
    assert.equal(onlyKey.statusCode, 200);

    // name 与 keyEnabled 都没有 → 400
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { channel: 'weixin', userId: 'wx_9' },
    });
    assert.equal(empty.statusCode, 400);

    // 任务不存在 → 404
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/t_nope',
      payload: { channel: 'weixin', userId: 'wx_9', keyEnabled: false },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close().catch(() => {});
  }
});

test('userId 缺省 → 走 default 用户路由；微信渠道 model 不参与 agent 路由', () => {
  const svc = freshService();
  // 仅 channel，不写 userId → default 用户三元素路由（会话隔离在 default 名下）
  const d1 = decideTaskRouting(svc, { text: '你好', channel: 'weixin', model: 'agent:pi' });
  assert.equal(d1.kind, 'chat');
  assert.equal(d1.agentId, 'pi'); // 微信渠道按 default 任务绑定 agent（model 不覆盖，固定本机 pi）
  assert.equal(d1.taskId, 'default');
  assert.equal(d1.sessionKey, 'weixin:default:task:default');
  // 显式 agent 优先于任务绑定
  const d2 = decideTaskRouting(svc, { text: '你好', channel: 'weixin', userId: 'wx_a', agent: 'pi', model: 'agent:opencode' });
  assert.equal(d2.kind, 'chat');
  assert.equal(d2.agentId, 'pi');
  // 仍无 channel → legacy
  const d3 = decideTaskRouting(svc, { text: '你好', model: 'agent:pi' });
  assert.equal(d3.kind, 'legacy');
});

test('微信渠道：model 不覆盖任务绑定 agent；taskKey 直连 model 仍可覆盖', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_m1');
  const t = svc.createTask(state, '股票', 'pi');
  // 激活任务绑定 pi，model: agent:opencode 不覆盖（微信渠道按任务绑定 agent）
  const d1 = decideTaskRouting(svc, { text: '继续', channel: 'weixin', userId: 'wx_m1', model: 'agent:opencode' });
  assert.equal(d1.kind, 'chat');
  assert.equal(d1.agentId, 'pi');
  assert.equal(d1.taskId, t.id);
  // taskKey 直连：model 仍可显式覆盖任务绑定 agent（通用客户端能力保留）
  const d2 = decideTaskRouting(svc, { text: '继续', taskKey: t.key, model: 'agent:opencode' });
  assert.equal(d2.kind, 'chat');
  assert.equal(d2.agentId, 'opencode');
});

test('taskKey 直连 + model 覆盖任务绑定 agent', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_k1');
  const t = svc.createTask(state, '分享', 'opencode');
  // key 直连默认走任务绑定 agent
  const d1 = decideTaskRouting(svc, { text: '继续', taskKey: t.key });
  assert.equal(d1.kind, 'chat');
  assert.equal(d1.agentId, 'opencode');
  assert.equal(d1.taskId, t.id);
  // model: agent:pi 覆盖
  const d2 = decideTaskRouting(svc, { text: '继续', taskKey: t.key, model: 'agent:pi' });
  assert.equal(d2.kind, 'chat');
  assert.equal(d2.agentId, 'pi');
});

/* ===================== 全局默认 Agent（tasks.defaultAgentId） ===================== */

test('TaskService: 默认任务固定本机 pi；setDefaultAgentId 只改空列表兜底', () => {
  const svc = freshService();
  assert.equal(svc.getDefaultAgentId(), 'pi');

  const before = svc.load('weixin', 'wx_old');
  assert.equal(before.tasks[0].agentId, 'pi');
  assert.equal(before.tasks[0].nodeId, 'local');

  assert.equal(svc.setDefaultAgentId(' OPENCODE '), 'opencode');
  assert.equal(svc.getDefaultAgentId(), 'opencode');

  // 已存在 / 新建用户的 default 任务仍钉死 pi
  assert.equal(svc.load('weixin', 'wx_old').tasks[0].agentId, 'pi');
  assert.equal(svc.load('weixin', 'wx_new').tasks[0].agentId, 'pi');

  assert.throws(() => svc.setDefaultAgentId('   '), /agentId/);
  assert.throws(() => svc.setTaskAgent(before, 'default', 'opencode'), /固定使用本机 pi/);
});

test('persistDefaultTaskAgentId: 就地改值并保留注释/其他键，重启重载可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cfg-'));
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(
    cfgPath,
    [
      '# 顶部注释应保留',
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '# tasks 段注释',
      'tasks:',
      '  defaultAgentId: opencode',
      '  workspaceDir: /tmp/ws',
    ].join('\n'),
    'utf8',
  );

  const written = persistDefaultTaskAgentId(cfgPath, 'pi');
  assert.equal(written, cfgPath);
  const out = readFileSync(cfgPath, 'utf8');
  assert.match(out, /# 顶部注释应保留/);
  assert.match(out, /# tasks 段注释/);
  assert.match(out, /defaultAgentId: pi/);
  assert.match(out, /workspaceDir: \/tmp\/ws/);
  assert.match(out, /port: 8787/);
  assert.doesNotMatch(out, /defaultAgentId: opencode/);

  // 重启视角：重新 loadGatewayConfig 读到新值
  const loaded = loadGatewayConfig(cfgPath);
  assert.equal(loaded.config.tasks.defaultAgentId, 'pi');
  assert.equal(loaded.config.tasks.workspaceDir, '/tmp/ws');
});

test('persistDefaultTaskAgentId: tasks 段缺失则补齐；文件不存在则创建最小段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cfg-'));

  // 只有 server 段
  const p1 = join(dir, 'a.yaml');
  writeFileSync(p1, 'server:\n  port: 9000\n', 'utf8');
  persistDefaultTaskAgentId(p1, 'codex');
  assert.match(readFileSync(p1, 'utf8'), /defaultAgentId: codex/);

  // 文件不存在（此前纯默认配置运行）
  const p2 = join(dir, 'nested', 'config.yaml');
  assert.ok(!existsSync(p2));
  persistDefaultTaskAgentId(p2, 'pi');
  assert.match(readFileSync(p2, 'utf8'), /defaultAgentId: pi/);

  assert.throws(() => persistDefaultTaskAgentId(p2, '  '), /不能为空/);
});

test('PUT /api/tasks/default-agent: 校验 agent、调用持久化回调、内存即时生效', async () => {
  const svc = freshService();
  const app = Fastify();
  const persisted: string[] = [];
  registerTaskApi(
    app,
    svc,
    () => true,
    {
      listAvailableAgents: () => ['opencode', 'pi'],
      persistDefaultAgent: async (id) => {
        persisted.push(id);
      },
    },
  );
  await app.ready();
  try {
    const got = await app.inject({ method: 'GET', url: '/api/tasks/default-agent' });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().defaultAgentId, 'pi');

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/tasks/default-agent',
      payload: { agentId: 'pi' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().defaultAgentId, 'pi');
    assert.deepEqual(persisted, ['pi']);

    // 新建用户默认任务即时绑定 pi
    const st = svc.load('weixin', 'wx_after_put');
    assert.equal(st.tasks[0].agentId, 'pi');

    // 未启用 / 不存在的 agent → 400，内存与回调均不变
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/tasks/default-agent',
      payload: { agentId: 'ghost' },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(svc.getDefaultAgentId(), 'pi');
    assert.deepEqual(persisted, ['pi']);

    // 缺 agentId → 400
    const empty = await app.inject({ method: 'PUT', url: '/api/tasks/default-agent', payload: {} });
    assert.equal(empty.statusCode, 400);
  } finally {
    await app.close().catch(() => {});
  }
});

test('PUT /api/tasks/default-agent: 持久化抛错时回滚内存值（不成功即不变）', async () => {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(
    app,
    svc,
    () => true,
    {
      listAvailableAgents: () => ['opencode', 'pi'],
      persistDefaultAgent: () => {
        throw new Error('disk full');
      },
    },
  );
  await app.ready();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/default-agent',
      payload: { agentId: 'pi' },
    });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /disk full/);
    // 内存值回滚为原值
    assert.equal(svc.getDefaultAgentId(), 'pi');
  } finally {
    await app.close().catch(() => {});
  }
});

test('PATCH /api/tasks/:id/agent: 注入 agent 校验后，不存在的 agent 400，合法可改', async () => {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(
    app,
    svc,
    () => true,
    { listAvailableAgents: () => ['opencode', 'pi'] },
  );
  await app.ready();
  try {
    // 先建一个任务
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_v', name: '方案', agentId: 'opencode' },
    });
    assert.equal(created.statusCode, 200);
    const taskId = created.json().id;

    // 不存在 / 停用的 agent → 400，任务绑定不变
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/agent`,
      payload: { channel: 'weixin', userId: 'wx_v', agentId: 'ghost' },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /Agent 不存在/);
    const afterBad = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_v' });
    assert.equal(afterBad.json().tasks.find((t: { id: string }) => t.id === taskId).agentId, 'opencode');

    // 合法 agent（大小写/空白归一化）→ 200，绑定变更落盘
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}/agent`,
      payload: { channel: 'weixin', userId: 'wx_v', agentId: ' PI ' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().task.agentId, 'pi');
  } finally {
    await app.close().catch(() => {});
  }
});

test('PATCH 默认任务 agent 一律 400；普通用户不能新建本机任务', async () => {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(app, svc, () => true, {
    isAdmin: (req) => req.headers['x-role'] === 'admin',
    sessionUser: () => ({ username: 'alice' }),
  });
  await app.ready();
  try {
    const adminPatch = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/default/agent',
      headers: { 'x-role': 'admin' },
      payload: { channel: 'web', userId: 'alice', agentId: 'opencode', ownerUsername: 'alice' },
    });
    assert.equal(adminPatch.statusCode, 400);
    assert.match(adminPatch.json().error, /本机 pi/);

    const userPatch = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/default/agent',
      payload: { channel: 'web', userId: 'alice', agentId: 'opencode', ownerUsername: 'alice' },
    });
    assert.equal(userPatch.statusCode, 400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'web', userId: 'alice', name: '本机任务', agentId: 'pi', ownerUsername: 'alice' },
    });
    assert.equal(created.statusCode, 403);
  } finally {
    await app.close().catch(() => {});
  }
});

