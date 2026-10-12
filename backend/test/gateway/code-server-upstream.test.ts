import assert from 'node:assert/strict';
import test from 'node:test';
import { toCodeServerProxyPath } from '../../src/gateway/code-server-upstream.js';

test('toCodeServerProxyPath：去掉 /vibe-ide 前缀并保留 query', () => {
  assert.equal(toCodeServerProxyPath('/vibe-ide/', '/vibe-ide'), '/');
  assert.equal(toCodeServerProxyPath('/vibe-ide', '/vibe-ide'), '/');
  assert.equal(toCodeServerProxyPath('/vibe-ide/?folder=/tmp', '/vibe-ide'), '/?folder=/tmp');
  assert.equal(toCodeServerProxyPath('/vibe-ide/stable-abc/_static/foo', '/vibe-ide'), '/stable-abc/_static/foo');
  assert.equal(toCodeServerProxyPath('/api/nodes', '/vibe-ide'), '/api/nodes');
});
