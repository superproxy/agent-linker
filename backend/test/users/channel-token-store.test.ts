import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelTokenStore,
  isChannelTokenShape,
  CHANNEL_TOKEN_PREFIX,
} from '../../src/gateway/users/channel-token-store.js';

function freshStore(): { dir: string; store: ChannelTokenStore } {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-ct-'));
  return { dir, store: new ChannelTokenStore(dir) };
}

test('签发 token：ct_ 前缀、可反查、ensure 幂等复用同一枚', () => {
  const { store } = freshStore();
  const rec = store.ensure('weixin', 'u1');
  assert.ok(rec.token.startsWith(CHANNEL_TOKEN_PREFIX));
  assert.equal(rec.channel, 'weixin');
  assert.equal(rec.userId, 'u1');

  // resolve 命中
  const got = store.resolve(rec.token);
  assert.ok(got);
  assert.equal(got?.userId, 'u1');

  // ensure 幂等：同一用户复用，不重复签发
  const again = store.ensure('weixin', 'u1');
  assert.equal(again.token, rec.token);
});

test('持久化：新实例从同一目录可读到已签发 token', () => {
  const { dir, store } = freshStore();
  const rec = store.ensure('weixin', 'persist-user');
  const reopened = new ChannelTokenStore(dir);
  assert.equal(reopened.resolve(rec.token)?.userId, 'persist-user');
});

test('形状判别：非 ct_ 前缀直接判否，避免无谓 KV 查询', () => {
  assert.equal(isChannelTokenShape('ct_abc'), true);
  assert.equal(isChannelTokenShape('k_taskkey'), false);
  assert.equal(isChannelTokenShape('deadbeef'), false);
  const { store } = freshStore();
  assert.equal(store.resolve('k_other'), null);
  assert.equal(store.resolve('not-a-token'), null);
});

test('轮换：revokeForUser 吊销旧 token，重新 ensure 签发新 token', () => {
  const { store } = freshStore();
  const old = store.ensure('weixin', 'rot');
  store.revokeForUser('weixin', 'rot');
  assert.equal(store.resolve(old.token), null);
  assert.equal(store.find('weixin', 'rot'), null);

  const fresh = store.ensure('weixin', 'rot');
  assert.notEqual(fresh.token, old.token);
  assert.ok(store.resolve(fresh.token));
});

test('按 owner 隔离：同 peer 不同绑定账号各持一枚；revokeForOwner 只清自己的', () => {
  const { store } = freshStore();
  const alice = store.ensure('weixin', 'wx_same', undefined, 'alice');
  const bob = store.ensure('weixin', 'wx_same', undefined, 'bob');
  assert.notEqual(alice.token, bob.token);
  assert.equal(store.ensure('weixin', 'wx_same', undefined, 'alice').token, alice.token);

  store.revokeForOwner('weixin', 'alice');
  assert.equal(store.resolve(alice.token), null);
  assert.ok(store.resolve(bob.token));
  const alice2 = store.ensure('weixin', 'wx_same', undefined, 'alice');
  assert.notEqual(alice2.token, alice.token);
});

test('revokeForOwner 同时清掉无归属旧票；ensure 带 owner 时不复用无归属 ct_', () => {
  const { store } = freshStore();
  const legacy = store.ensure('weixin', 'wx_old');
  assert.equal(legacy.ownerUsername, undefined);

  store.revokeForOwner('weixin', 'alice');
  assert.equal(store.resolve(legacy.token), null);

  const leftover = store.ensure('weixin', 'wx_peer');
  const owned = store.ensure('weixin', 'wx_peer', undefined, 'alice');
  assert.notEqual(owned.token, leftover.token);
  assert.equal(store.resolve(leftover.token), null);
  assert.equal(owned.ownerUsername, 'alice');
});

test('不同用户互不影响；list 返回全部记录', () => {
  const { store } = freshStore();
  const a = store.ensure('weixin', 'a');
  const b = store.ensure('weixin', 'b');
  assert.equal(store.resolve(a.token)?.userId, 'a');
  assert.equal(store.resolve(b.token)?.userId, 'b');
  const list = store.list();
  assert.equal(list.length, 2);
  // 不依赖同毫秒创建时间的先后，仅校验两个用户都在结果集中
  assert.deepEqual(list.map((r) => r.userId).sort(), ['a', 'b']);
});

test('touch 更新最近使用时间但不改凭据', () => {
  const { store } = freshStore();
  const rec = store.ensure('weixin', 'touch-user');
  assert.equal(rec.lastUsedAt, undefined);
  store.touch(rec.token);
  const after = store.resolve(rec.token);
  assert.ok(after?.lastUsedAt);
});
