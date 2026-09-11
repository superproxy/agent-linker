import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { decideTaskRouting } from '../../src/gateway/tasks/api.js';

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
  assert.equal(d.agentId, 'opencode');
  assert.equal(d.taskId, 'default');
  assert.equal(d.sessionKey, 'weixin:wx_1:task:default');
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
  assert.equal(d.agentId, 'opencode'); // defaultAgentId
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
    assert.equal(body.tasks[0].agentId, 'opencode');
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

test('/api/tasks: 删除 default 拒绝（400）', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/default?channel=weixin&userId=wx_9',
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks/all: 返回全部用户任务明细（管理后台任务页）', async () => {
  const app = await freshApp();
  try {
    // 两个用户各建任务
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_1', name: '方案A', agentId: 'pi' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_2', name: '周报' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/all' });
    assert.equal(res.statusCode, 200);
    const users = res.json().users;
    assert.ok(users.length >= 2);

    const u1 = users.find((u: { userId: string }) => u.userId === 'wx_1');
    assert.ok(u1);
    assert.equal(u1.tasks.length, 2); // default + 方案A
    assert.equal(u1.tasks.find((t: { name: string }) => t.name === '方案A').agentId, 'pi');

    const u2 = users.find((u: { userId: string }) => u.userId === 'wx_2');
    assert.ok(u2);
    // 新建即激活
    const created = u2.tasks.find((t: { name: string }) => t.name === '周报');
    assert.ok(created);
    assert.equal(u2.activeTaskId, created.id);
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
  assert.equal(d1.agentId, 'opencode'); // 微信渠道按 default 任务绑定 agent（model 不覆盖，defaultAgentId 权威）
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
