import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ensureTaskCwdExists,
  isLegacyBrokenTaskCwd,
  isWindowsDriveRoot,
  resolveCwd,
  resolveTaskPath,
  resolveTaskWorkspaceRoot,
} from '../../src/util/task-paths.js';

test('resolveCwd：拒绝 Windows 仅盘符', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => resolveCwd('D:'), /不能仅为盘符/);
  assert.throws(() => resolveCwd('d:'), /不能仅为盘符/);
});

test('resolveCwd：Windows 盘符相对路径 join 问题应用 resolve 修复', { skip: process.platform !== 'win32' }, () => {
  const root = resolve('D:', 'linkagent-ws-test');
  const p = resolveTaskPath(root, 'alice', 't_abc12345');
  assert.match(p, /^D:\\/i);
  assert.ok(p.endsWith('t_abc12345') || p.includes('t_abc12345'));
  assert.equal(isWindowsDriveRoot(p), false);
});

test('resolveCwd：磁盘根目录拒绝', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => resolveCwd('D:\\'), /磁盘根目录/);
  assert.throws(() => resolveTaskWorkspaceRoot('D:\\'), /磁盘根目录/);
  assert.equal(isLegacyBrokenTaskCwd('d:\\'), true);
  assert.equal(isLegacyBrokenTaskCwd('D:'), true);
});

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
