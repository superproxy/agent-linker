import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeTokenStore,
  isNodeTokenShape,
  NODE_TOKEN_PREFIX,
} from '../../src/gateway/users/node-token-store.js';

function freshStore(): { dir: string; store: NodeTokenStore } {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-nt-'));
  return { dir, store: new NodeTokenStore(dir) };
}

test('签发：nt_ 前缀、可反查；同一用户可持有多枚', () => {
  const { store } = freshStore();
  const a = store.issue('alice', '家里的 PC');
  const b = store.issue('alice');
  assert.ok(a.token.startsWith(NODE_TOKEN_PREFIX));
  assert.ok(a.id.startsWith('ntk_'));
  assert.equal(a.username, 'alice');
  assert.equal(a.label, '家里的 PC');
  assert.notEqual(a.token, b.token);
  assert.equal(store.listForUser('alice').length, 2);
  assert.equal(store.resolve(a.token)?.id, a.id);
});

test('持久化：新实例从同一目录可读到已签发 token', () => {
  const { dir, store } = freshStore();
  const rec = store.issue('persist-user');
  const reopened = new NodeTokenStore(dir);
  assert.equal(reopened.resolve(rec.token)?.username, 'persist-user');
});

test('形状判别：非 nt_ 前缀直接判否', () => {
  assert.equal(isNodeTokenShape('nt_abc'), true);
  assert.equal(isNodeTokenShape('pat_abc'), false);
  assert.equal(isNodeTokenShape('secret'), false);
  const { store } = freshStore();
  assert.equal(store.resolve('pat_abc'), null);
  assert.equal(store.resolve('not-a-token'), null);
});

test('bindNode：首次锁定；同机可再绑；换机失败', () => {
  const { store } = freshStore();
  const rec = store.issue('alice');
  assert.equal(store.bindNode(rec.token, 'n_aaa'), true);
  assert.equal(store.resolve(rec.token)?.nodeId, 'n_aaa');
  assert.equal(store.bindNode(rec.token, 'n_aaa'), true);
  assert.equal(store.bindNode(rec.token, 'n_bbb'), false);
  assert.equal(store.resolve(rec.token)?.nodeId, 'n_aaa');
});

test('轮换：旧 token 失效、解除 nodeId 锁定；吊销仅限本人', () => {
  const { store } = freshStore();
  const alice = store.issue('alice');
  store.bindNode(alice.token, 'n_aaa');
  const rotated = store.rotate('alice', alice.id);
  assert.ok(rotated);
  assert.notEqual(rotated?.token, alice.token);
  assert.equal(rotated?.nodeId, undefined);
  assert.equal(store.resolve(alice.token), null);
  assert.ok(store.resolve(rotated!.token));

  const bob = store.issue('bob');
  assert.equal(store.revoke('alice', bob.id), false);
  assert.ok(store.resolve(bob.token));
  assert.equal(store.revoke('bob', bob.id), true);
  assert.equal(store.resolve(bob.token), null);
});

test('revokeForUser 清掉该账号全部机器凭证', () => {
  const { store } = freshStore();
  const a = store.issue('alice');
  store.issue('alice');
  store.issue('bob');
  store.revokeForUser('alice');
  assert.equal(store.listForUser('alice').length, 0);
  assert.equal(store.resolve(a.token), null);
  assert.equal(store.listForUser('bob').length, 1);
});
