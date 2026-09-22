import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeClaimStore, isNodeClaimShape } from '../../src/gateway/users/node-claim-store.js';

test('node claim store：ensure 幂等、resolve、revoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-nu-'));
  const store = new NodeClaimStore(dir);
  const a = store.ensure('alice');
  assert.ok(isNodeClaimShape(a.token));
  const b = store.ensure('alice');
  assert.equal(a.token, b.token);
  assert.equal(store.resolve(a.token)?.username, 'alice');
  store.revokeForUser('alice');
  assert.equal(store.resolve(a.token), null);
});
