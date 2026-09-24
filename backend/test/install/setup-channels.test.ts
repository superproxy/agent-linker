import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSetupChannelsArgs,
  verifyChannelPlugins,
  findChannelPluginEntry,
  REPO_ROOT,
  DEFAULT_CHANNEL_PLUGINS,
} from '../../../scripts/setup-channels.mjs';

test('parseSetupChannelsArgs', () => {
  assert.deepEqual(parseSetupChannelsArgs([]), { skipInstall: false, lark: false });
  assert.deepEqual(parseSetupChannelsArgs(['--skip-install', '--lark']), { skipInstall: true, lark: true });
});

test('findChannelPluginEntry：企微/飞书插件在 backend/node_modules', () => {
  for (const pkg of DEFAULT_CHANNEL_PLUGINS) {
    assert.ok(findChannelPluginEntry(REPO_ROOT, pkg), `缺少 ${pkg}`);
  }
});

test('verifyChannelPlugins：仓库 backend 已声明的插件可解析', async () => {
  await verifyChannelPlugins(REPO_ROOT, DEFAULT_CHANNEL_PLUGINS);
});

test('setup-channels.mjs --skip-install 可执行', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'setup-channels.mjs'), '--skip-install'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
