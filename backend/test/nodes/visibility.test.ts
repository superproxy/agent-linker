import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSeeNode } from '../../src/gateway/nodes/visibility.js';

test('管理员可见全部节点；其他人只看本机和自己的机器', () => {
  const local = { nodeId: 'local' };
  const mine = { nodeId: 'n_1', ownerUsername: 'alice' };
  const theirs = { nodeId: 'n_2', ownerUsername: 'bob' };
  const orphan = { nodeId: 'n_3' };

  const admin = { admin: true, username: 'admin' };
  assert.equal(canSeeNode(local, admin), true);
  assert.equal(canSeeNode(mine, admin), true);
  assert.equal(canSeeNode(theirs, admin), true);
  assert.equal(canSeeNode(orphan, admin), true);

  const alice = { admin: false, username: 'alice' };
  assert.equal(canSeeNode(local, alice), true);
  assert.equal(canSeeNode(mine, alice), true);
  assert.equal(canSeeNode(theirs, alice), false);
  assert.equal(canSeeNode(orphan, alice), false);
});
