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
