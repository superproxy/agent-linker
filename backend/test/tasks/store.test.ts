import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    tasks: [{ id: 'default', key: 'k_default1', name: '默认', agentId: 'opencode', createdAt: 123 }],
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

test('write 覆盖旧值且不留 .tmp 残留（原子替换）', () => {
  const dir = freshDir();
  const store = createJsonStore(dir);
  const base: UserTasks = {
    channel: 'weixin',
    userId: 'wx_1',
    activeTaskId: 'default',
    tasks: [{ id: 'default', key: 'k_base', name: '默认', agentId: 'opencode', createdAt: 1 }],
  };
  store.write(base);
  const v2: UserTasks = {
    ...base,
    activeTaskId: 't_abc',
    tasks: [
      { id: 'default', key: 'k_base', name: '默认', agentId: 'opencode', createdAt: 1 },
      { id: 't_abc', key: 'k_v2', name: '新任务', agentId: 'pi', createdAt: 2 },
    ],
  };
  store.write(v2);
  // 第二次写完整覆盖第一次，读到的永远是完整状态
  assert.deepEqual(store.read('weixin', 'wx_1'), v2);
  // 无 .tmp 残留文件
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  rmSync(dir, { recursive: true, force: true });
});
