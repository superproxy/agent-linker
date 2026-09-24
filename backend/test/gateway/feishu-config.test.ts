import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { persistFeishuChannelSetup, readFeishuConfigView, readFeishuCredentials } from '../../src/config/persist-feishu.js';

function writeSplit(dir: string): void {
  writeFileSync(
    join(dir, 'gateway.yaml'),
    'server:\n  host: 127.0.0.1\n  port: 8787\nauth:\n  mode: open\nagents: []\nplugins: []\nchannels: {}\n',
  );
  writeFileSync(join(dir, 'weixin.yaml'), 'enabled: false\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: false\nagents: []\n');
  writeFileSync(join(dir, 'channels.yaml'), 'channelGateway:\n  enabled: false\n');
}

test('persistFeishuChannelSetup：只写 channels.yaml，OpenClaw accounts.default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-feishu-'));
  writeSplit(dir);
  const gatewayFile = join(dir, 'gateway.yaml');
  const gwBefore = readFileSync(gatewayFile, 'utf8');
  persistFeishuChannelSetup(
    gatewayFile,
    { enabled: true, appId: 'cli_xxx', appSecret: 'sec-feishu', connectionMode: 'websocket', pluginPackage: '@openclaw/feishu' },
    { enabled: true, feishu: true, feishuPluginPackage: '@openclaw/feishu' },
  );
  assert.equal(readFileSync(gatewayFile, 'utf8'), gwBefore);
  const chRaw = parse(readFileSync(join(dir, 'channels.yaml'), 'utf8')) as Record<string, unknown>;
  const cg = chRaw.channelGateway as Record<string, unknown>;
  assert.equal(cg.enabled, true);
  assert.equal(cg.feishu, true);
  assert.equal(cg.feishuPluginPackage, '@openclaw/feishu');
  const channels = cg.channels as Record<string, unknown>;
  const feishu = channels.feishu as Record<string, unknown>;
  const cred = readFeishuCredentials(feishu);
  assert.equal(cred.appId, 'cli_xxx');
  assert.equal(cred.appSecret, 'sec-feishu');
  const view = readFeishuConfigView(gatewayFile);
  assert.equal(view.feishu.enabled, true);
});
