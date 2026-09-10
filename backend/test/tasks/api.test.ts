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
