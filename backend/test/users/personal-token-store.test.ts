import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PersonalTokenStore,
  isPersonalTokenShape,
  PERSONAL_TOKEN_PREFIX,
} from '../../src/gateway/users/personal-token-store.js';

function freshStore(): { dir: string; store: PersonalTokenStore } {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-pat-'));
  return { dir, store: new PersonalTokenStore(dir) };
}

test('签发 token：pat_ 前缀、可反查、ensure 幂等复用同一枚', () => {
  const { store } = freshStore();
  const rec = store.ensure('alice');
  assert.ok(rec.token.startsWith(PERSONAL_TOKEN_PREFIX));
  assert.equal(rec.username, 'alice');

  // resolve 命中
  const got = store.resolve(rec.token);
  assert.ok(got);
  assert.equal(got?.username, 'alice');

  // ensure 幂等：同一账号复用，不重复签发
  const again = store.ensure('alice');
  assert.equal(again.token, rec.token);
});

test('持久化：新实例从同一目录可读到已签发 token', () => {
  const { dir, store } = freshStore();
  const rec = store.ensure('persist-user');
  const reopened = new PersonalTokenStore(dir);
  assert.equal(reopened.resolve(rec.token)?.username, 'persist-user');
});

test('形状判别：非 pat_ 前缀直接判否，避免无谓 KV 查询', () => {
  assert.equal(isPersonalTokenShape('pat_abc'), true);
  assert.equal(isPersonalTokenShape('ct_other'), false);
  assert.equal(isPersonalTokenShape('k_taskkey'), false);
  assert.equal(isPersonalTokenShape('deadbeef'), false);
  const { store } = freshStore();
  assert.equal(store.resolve('ct_other'), null);
  assert.equal(store.resolve('not-a-token'), null);
});

test('轮换：revokeForUser 吊销旧 token，重新 issue 签发新 token', () => {
  const { store } = freshStore();
  const old = store.ensure('rot');
  store.revokeForUser('rot');
  assert.equal(store.resolve(old.token), null);
  assert.equal(store.find('rot'), null);

  const fresh = store.issue('rot');
  assert.notEqual(fresh.token, old.token);
  assert.ok(store.resolve(fresh.token));
});

test('不同账号互不影响；find 各自只取自己那一枚', () => {
  const { store } = freshStore();
  const a = store.ensure('alice');
  const b = store.ensure('bob');
  assert.equal(store.resolve(a.token)?.username, 'alice');
  assert.equal(store.resolve(b.token)?.username, 'bob');
  assert.equal(store.find('alice')?.token, a.token);
  assert.equal(store.find('bob')?.token, b.token);
  assert.equal(store.find('nobody'), null);
});

test('revoke 仅允许吊销属于自己的 token，防越权删除他人凭据', () => {
  const { store } = freshStore();
  const a = store.ensure('alice');
  // bob 尝试吊销 alice 的 token：失败且 token 仍有效
  assert.equal(store.revoke('bob', a.token), false);
  assert.ok(store.resolve(a.token));
  // 本人吊销：成功
  assert.equal(store.revoke('alice', a.token), true);
  assert.equal(store.resolve(a.token), null);
});

test('touch 更新最近使用时间但不改凭据', () => {
  const { store } = freshStore();
  const rec = store.ensure('touch-user');
  assert.equal(rec.lastUsedAt, undefined);
  store.touch(rec.token);
  const after = store.resolve(rec.token);
  assert.ok(after?.lastUsedAt);
});
