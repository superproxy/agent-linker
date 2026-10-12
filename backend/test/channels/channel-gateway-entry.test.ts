import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';

test('bin/channels.mjs 作为 CLI 入口会执行 main（非静默 exit 0）', () => {
  const root = findRepoRoot();
  const bundle = join(root, 'dist', 'linkagent', 'bin', 'channels.mjs');
  const install = join(root, 'dist', 'linkagent');
  if (!existsSync(bundle)) return;

  const r = spawnSync(process.execPath, [bundle], {
    cwd: install,
    env: { ...process.env, LINKAGENT_HOME: install },
    encoding: 'utf8',
    timeout: 8_000,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.notEqual(r.status, 0, `channels.mjs 不应无输出立即成功：${text.slice(0, 400)}`);
  assert.match(text, /未启动任何渠道|channelGateway|微信|企微/);
});
