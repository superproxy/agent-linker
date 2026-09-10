import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import type { UserTasks } from '../../src/gateway/tasks/types.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
}

test('read 不存在的用户返回 null', () => {
  const store = createJsonStore(freshDir());
  assert.equal(store.read('weixin', 'wx_1'), null);
});

test('write 后 read 还原，文件名安全转义', () => {
  const dir = freshDir();
  const store = createJsonStore(dir);
  const data: UserTasks = {
    channel: 'weixin',
    userId: 'wx_1',
    activeTaskId: 'default',
    tasks: [{ id: 'default', name: '默认', agentId: 'opencode', createdAt: 123 }],
  };
  store.write(data);
  assert.deepEqual(store.read('weixin', 'wx_1'), data);
  // 用户 id 含特殊字符（微信 openid 等）时文件名安全
  store.write({ channel: 'weixin', userId: 'a/b?c', activeTaskId: 'default', tasks: [] });
  assert.deepEqual(store.read('weixin', 'a/b?c'), {
    channel: 'weixin',
    userId: 'a/b?c',
    activeTaskId: 'default',
    tasks: [],
  });
});

test('损坏的 JSON 返回 null（调用方重建）', () => {
  const dir = freshDir();
  const file = join(dir, 'weixin.x.json');
  writeFileSync(file, '{broken json', 'utf8');
  const store = createJsonStore(dir);
  assert.equal(store.read('weixin', 'x'), null);
  rmSync(dir, { recursive: true, force: true });
});
