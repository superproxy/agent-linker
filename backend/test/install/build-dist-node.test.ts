import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';

test('build-dist --target=node --skip-install 产出仅含连接器的独立包', () => {
  const repo = findRepoRoot();
  const out = mkdtempSync(join(tmpdir(), 'linkagent-node-dist-'));
  const r = spawnSync(
    process.execPath,
    ['scripts/build-dist.mjs', '--target=node', '--skip-install', `--out=${out}`],
    { cwd: repo, encoding: 'utf8', timeout: 90_000 },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout || 'build-dist node 失败');
  assert.ok(existsSync(join(out, '.linkagent-root')));
  assert.ok(existsSync(join(out, 'server', 'node.mjs')));
  assert.ok(existsSync(join(out, 'server', 'ctl.mjs')));
  assert.ok(existsSync(join(out, 'start.sh')));
  assert.ok(existsSync(join(out, 'start.bat')));
  assert.ok(existsSync(join(out, 'node.env.example')));
  assert.equal(existsSync(join(out, 'server', 'gateway.mjs')), false);
  assert.equal(existsSync(join(out, 'web')), false);

  const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'linkagent-node');
  assert.ok(pkg.dependencies.acpx);
  assert.ok(pkg.dependencies.ws);
  assert.equal(pkg.dependencies.fastify, undefined);
});
