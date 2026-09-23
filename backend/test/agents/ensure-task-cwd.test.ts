import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureTaskCwdExists } from '../../src/gateway/agents/acpEngine.js';

test('ensureTaskCwdExists：目录不存在时递归创建', () => {
  const root = mkdtempSync(join(tmpdir(), 'la-ensure-cwd-'));
  try {
    const target = join(root, 'alice', 't_abc12345');
    assert.equal(existsSync(target), false);
    const resolved = ensureTaskCwdExists(target);
    assert.equal(resolved, resolve(target));
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureTaskCwdExists：已存在时不报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'la-ensure-cwd-'));
  try {
    const target = join(root, 'existing');
    assert.doesNotThrow(() => {
      ensureTaskCwdExists(target);
      ensureTaskCwdExists(target);
    });
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
