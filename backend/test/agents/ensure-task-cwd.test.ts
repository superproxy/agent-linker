import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureTaskCwdExists, formatAgentSpawnFailure } from '../../src/gateway/agents/acpEngine.js';

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

test('formatAgentSpawnFailure：附带 cwd 是否存在', () => {
  const root = mkdtempSync(join(tmpdir(), 'la-spawn-hint-'));
  try {
    const err = formatAgentSpawnFailure(['definitely-not-a-real-binary-xyz'], root, new Error('spawn failed'));
    assert.match(err.message, /spawn failed/);
    assert.match(err.message, /工作目录:.*已存在/);
    assert.match(err.message, /definitely-not-a-real-binary-xyz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
