import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { decideTaskRouting } from '../../src/gateway/tasks/api.js';

function freshService(): TaskService {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-locked-'));
  return new TaskService({ store: createJsonStore(dir) });
}

test('lockedTask：强制路由到鉴权锁定的任务，忽略 body 的 channel/userId/agent/task（防越权）', () => {
  const svc = freshService();
  // 属主 owner-1 建一个绑定 pi 的任务
  const ownerState = svc.load('weixin', 'owner-1');
  const locked = svc.createTask(ownerState, '属主任务', 'pi');

  // 攻击者在 body 里伪造他人身份、想切到别的 agent/任务，但鉴权层已锁定 owner-1/locked
  const d = decideTaskRouting(svc, {
    text: '帮我干活',
    channel: 'weixin',
    userId: 'attacker', // 应被忽略
    agent: 'opencode', // 应被忽略：持单任务 key 不得切换 agent
    task: 'default', // 应被忽略
    lockedTask: { channel: 'weixin', userId: 'owner-1', taskId: locked.id },
  });

  assert.equal(d.kind, 'chat');
  if (d.kind === 'chat') {
    assert.equal(d.taskId, locked.id);
    assert.equal(d.agentId, 'pi'); // 取任务绑定，而非 body.agent
    assert.equal(d.sessionKey, `weixin:owner-1:task:${locked.id}`);
  }
});

test('lockedTask：命令文本仍在锁定用户的任务态内解析（/task list）', () => {
  const svc = freshService();
  const ownerState = svc.load('weixin', 'owner-cmd');
  const locked = svc.createTask(ownerState, '命令任务', 'opencode');
  const d = decideTaskRouting(svc, {
    text: '/task list',
    channel: 'weixin',
    userId: 'someone-else',
    lockedTask: { channel: 'weixin', userId: 'owner-cmd', taskId: locked.id },
  });
  assert.equal(d.kind, 'command');
  if (d.kind === 'command') {
    assert.ok(d.text?.includes('任务列表'));
  }
});
