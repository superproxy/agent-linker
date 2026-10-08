import assert from 'node:assert/strict';
import test from 'node:test';
import { isVibeIdePath } from '../../src/gateway/vibe-ide-proxy.js';

test('isVibeIdePath：只匹配 /vibe-ide 前缀', () => {
  assert.equal(isVibeIdePath('/vibe-ide'), true);
  assert.equal(isVibeIdePath('/vibe-ide/'), true);
  assert.equal(isVibeIdePath('/vibe-ide/?folder=1'), true);
  assert.equal(isVibeIdePath('/vibe-ide/stable-xxx'), true);
  assert.equal(isVibeIdePath('/api/nodes/ws'), false);
  assert.equal(isVibeIdePath('/vibe-idea'), false);
  assert.equal(isVibeIdePath(undefined), false);
});
