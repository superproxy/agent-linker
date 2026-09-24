import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePluginAccountStatus } from '../../src/plugins/account-status.js';

test('mergePluginAccountStatus：部分 patch 保留 running', () => {
  const prev = { running: true, lastError: null, lastStartAt: 100 };
  const next = mergePluginAccountStatus(prev, { lastError: 'x' });
  assert.equal(next.running, true);
  assert.equal(next.lastError, 'x');
  assert.equal(next.lastStartAt, 100);
});

test('mergePluginAccountStatus：无 prev 时 running 默认 false', () => {
  const next = mergePluginAccountStatus(undefined, {});
  assert.equal(next.running, false);
  assert.ok(next.lastStartAt !== null);
});
