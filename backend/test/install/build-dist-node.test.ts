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

  const bundled = readFileSync(join(out, 'server', 'node.mjs'), 'utf8');
  assert.match(bundled, /createRequire/, 'ESM bundle 需注入 createRequire，否则 yaml 的 require("node:process") 会炸');

  // 未装 acpx 时会很快退出；装了则会连网关。只要不再炸 Dynamic require 即通过。
  const boot = spawnSync(process.execPath, [join(out, 'server', 'node.mjs')], {
    encoding: 'utf8',
    timeout: 4_000,
    env: { ...process.env, LINKAGENT_HOME: out },
  });
  const text = `${boot.stdout ?? ''}${boot.stderr ?? ''}`;
  assert.equal(
    text.includes('Dynamic require of'),
    false,
    `节点包启动不应再动态 require 失败：${text.slice(0, 800)}`,
  );
});
