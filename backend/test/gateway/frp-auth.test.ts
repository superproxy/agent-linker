import assert from 'node:assert/strict';
import test from 'node:test';
import { frpPrivilegeKey, resolveFrpLogin } from '../../src/gateway/edge/frp-auth.js';

test('frpPrivilegeKey：md5(token + timestamp)', () => {
  assert.equal(frpPrivilegeKey('secret', 10), '55af97d221b30c4ed7121b9ab72edc62');
});

test('resolveFrpLogin：内部 token 原样通过，nt_ 改写，其它拒绝', () => {
  const timestamp = 42;
  const serverToken = 'server-secret';
  const nodeToken = 'nt_abc';
  const serverKey = frpPrivilegeKey(serverToken, timestamp);
  assert.deepEqual(
    resolveFrpLogin({ privilegeKey: serverKey, timestamp, serverToken, nodeTokens: [nodeToken] }),
    { action: 'allow' },
  );
  assert.deepEqual(
    resolveFrpLogin({
      privilegeKey: frpPrivilegeKey(nodeToken, timestamp),
      timestamp,
      serverToken,
      nodeTokens: [nodeToken],
    }),
    { action: 'rewrite', privilegeKey: serverKey },
  );
  assert.equal(
    resolveFrpLogin({ privilegeKey: frpPrivilegeKey('other', timestamp), timestamp, serverToken, nodeTokens: [nodeToken] }).action,
    'reject',
  );
});
