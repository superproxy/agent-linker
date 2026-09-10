import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { DEFAULT_TASK_ID } from '../../src/gateway/tasks/types.js';

function freshService(): TaskService {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  return new TaskService({ store: createJsonStore(dir) });
}

test('首次 load 预置 default 任务', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, DEFAULT_TASK_ID);
  assert.equal(state.tasks[0].agentId, 'opencode');
  assert.equal(state.activeTaskId, DEFAULT_TASK_ID);
});

test('createTask 追加并激活，agent 缺省继承当前激活', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '写方案', 'pi');
  assert.equal(state.tasks.length, 2);
  assert.equal(state.activeTaskId, t.id);
  assert.equal(t.agentId, 'pi');
  const t2 = svc.createTask(state, '另一个'); // agent 缺省继承 pi
  assert.equal(t2.agentId, 'pi');
});

test('activate / delete / rename', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查bug', 'opencode');
  svc.createTask(state, '写方案', 'pi');
  const back = svc.activateTask(state, DEFAULT_TASK_ID);
  assert.equal(state.activeTaskId, DEFAULT_TASK_ID);
  assert.equal(back.id, DEFAULT_TASK_ID);
  assert.throws(() => svc.activateTask(state, 'nope'), /任务不存在/);
  assert.throws(() => svc.deleteTask(state, DEFAULT_TASK_ID), /默认任务不可删除/);
  svc.deleteTask(state, t.id);
  assert.ok(!state.tasks.some((x) => x.id === t.id));
  const renamed = svc.renameTask(state, DEFAULT_TASK_ID, '主任务');
  assert.equal(renamed.name, '主任务');
});

test('删除激活任务后回落到剩余第一个', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const a = svc.createTask(state, 'A', 'pi');
  svc.createTask(state, 'B', 'opencode');
  svc.activateTask(state, a.id);
  svc.deleteTask(state, a.id);
  assert.notEqual(state.activeTaskId, a.id);
  assert.ok(state.tasks.some((x) => x.id === state.activeTaskId));
});

test('resolveRoute 缺省用激活任务，可覆盖', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查', 'pi');
  const r1 = svc.resolveRoute(state);
  assert.equal(r1.taskId, t.id);
  assert.equal(r1.agentId, 'pi');
  const r2 = svc.resolveRoute(state, DEFAULT_TASK_ID);
  assert.equal(r2.taskId, DEFAULT_TASK_ID);
  assert.equal(r2.agentId, 'opencode');
});
