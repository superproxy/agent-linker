import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKvJsonStore, safeFileName } from '../../src/gateway/store/kv.js';
import { createNodeRegistry } from '../../src/gateway/nodes/store.js';
import { createPreferenceStore } from '../../src/gateway/prefs/store.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-kv-'));
}

test('safeFileName：仅保留字母数字 . _ -，其余转义防路径注入', () => {
  assert.equal(safeFileName('abc'), 'abc');
  assert.equal(safeFileName('a.b-c_d'), 'a.b-c_d');
  assert.equal(safeFileName('../etc/passwd'), '.._etc_passwd');
  assert.equal(safeFileName('a/b\\c'), 'a_b_c');
  assert.equal(safeFileName('wx|user@im'), 'wx_user_im');
});

test('KvJsonStore：put/get 往返、覆盖、删除、list', () => {
  const kv = createKvJsonStore<{ v: number }>(tmpDir());
  assert.equal(kv.get('a'), null);
  kv.put('a', { v: 1 });
  kv.put('b', { v: 2 });
  assert.deepEqual(kv.get('a'), { v: 1 });
  kv.put('a', { v: 11 });
  assert.deepEqual(kv.get('a'), { v: 11 });
  assert.equal(kv.list().length, 2);
  kv.delete('a');
  assert.equal(kv.get('a'), null);
  assert.equal(kv.list().length, 1);
  // 删除不存在的 key 不报错
  kv.delete('nonexistent');
});

test('KvJsonStore：损坏 JSON 返回 null 且不阻塞 list；不残留 .tmp', () => {
  const dir = tmpDir();
  const kv = createKvJsonStore<{ v: number }>(dir);
  kv.put('ok', { v: 1 });
  writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
  assert.equal(kv.get('broken'), null);
  const all = kv.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], { v: 1 });
  assert.ok(!existsSync(join(dir, 'ok.json.tmp')));
});

test('KvJsonStore：特殊字符 key 被转义后仍可往返', () => {
  const kv = createKvJsonStore<{ v: number }>(tmpDir());
  kv.put('weixin|o@xxx', { v: 7 });
  assert.deepEqual(kv.get('weixin|o@xxx'), { v: 7 });
});

test('NodeRegistry：upsert/get/remove + list 按 lastSeenAt 倒序', () => {
  const reg = createNodeRegistry(tmpDir());
  assert.deepEqual(reg.list(), []);
  const t = Date.now();
  reg.upsert({ nodeId: 'n1', name: 'node-1', agents: [{ id: 'pi' }], createdAt: t, lastSeenAt: 100 });
  reg.upsert({ nodeId: 'n2', name: 'node-2', agents: [], createdAt: t, lastSeenAt: 300 });
  assert.equal(reg.get('n1')?.name, 'node-1');
  assert.deepEqual(reg.list().map((r) => r.nodeId), ['n2', 'n1']);
  reg.remove('n2');
  assert.equal(reg.get('n2'), null);
  assert.deepEqual(reg.list().map((r) => r.nodeId), ['n1']);
});

test('NodeRegistry：落盘后新实例可恢复（离线节点注册记录持久化）', () => {
  const dir = tmpDir();
  const reg1 = createNodeRegistry(dir);
  reg1.upsert({ nodeId: 'n1', name: 'persisted', agents: [{ id: 'opencode', displayName: 'OpenCode' }], createdAt: 1, lastSeenAt: 1 });
  const reg2 = createNodeRegistry(dir);
  const rec = reg2.get('n1');
  assert.ok(rec);
  assert.equal(rec?.name, 'persisted');
  assert.deepEqual(rec?.agents, [{ id: 'opencode', displayName: 'OpenCode' }]);
});

test('PreferenceStore：put/get 按 channel.userId 隔离，缺失返回 null', () => {
  const prefs = createPreferenceStore(tmpDir());
  assert.equal(prefs.get('wx', 'u1'), null);
  prefs.put({ channel: 'wx', userId: 'u1', defaultNodeId: 'n1', defaultAgentId: 'pi', updatedAt: 1 });
  assert.equal(prefs.get('wx', 'u1')?.defaultNodeId, 'n1');
  assert.equal(prefs.get('wx', 'u1')?.defaultAgentId, 'pi');
  assert.equal(prefs.get('wx', 'u2'), null);
  assert.equal(prefs.get('api', 'u1'), null);
  // 覆盖
  prefs.put({ channel: 'wx', userId: 'u1', defaultNodeId: 'local', defaultAgentId: 'opencode', updatedAt: 2 });
  assert.equal(prefs.get('wx', 'u1')?.defaultAgentId, 'opencode');
});
