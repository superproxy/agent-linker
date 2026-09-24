import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { persistWeixinChannelGatewaySetup } from '../../src/config/persist-weixin.js';

function writeSplit(dir: string): void {
  writeFileSync(
    join(dir, 'gateway.yaml'),
    'server:\n  host: 127.0.0.1\n  port: 8787\nauth:\n  mode: open\nagents: []\nplugins:\n  - package: "@tencent-weixin/openclaw-weixin"\nchannels:\n  openclaw-weixin:\n    agentId: pi\n',
  );
  writeFileSync(join(dir, 'weixin.yaml'), 'enabled: false\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: false\nagents: []\n');
  writeFileSync(join(dir, 'channels.yaml'), 'channelGateway:\n  enabled: false\n');
}

test('persistWeixinChannelGatewaySetup：写入 weixinPlugin 与插件包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-weixin-cg-'));
  writeSplit(dir);
  const gatewayFile = join(dir, 'gateway.yaml');
  persistWeixinChannelGatewaySetup(gatewayFile, {
    enabled: true,
    weixin: true,
    weixinPlugin: true,
    model: 'agent:pi',
  });
  const chRaw = parse(readFileSync(join(dir, 'channels.yaml'), 'utf8')) as Record<string, unknown>;
  const cg = chRaw.channelGateway as Record<string, unknown>;
  assert.equal(cg.enabled, true);
  assert.equal(cg.weixin, true);
  assert.equal(cg.weixinPlugin, true);
  const plugins = cg.plugins as Array<{ package: string }>;
  assert.ok(plugins.some((p) => p.package.includes('openclaw-weixin')));
  const channels = cg.channels as Record<string, unknown>;
  const wx = channels['openclaw-weixin'] as Record<string, unknown>;
  assert.equal(wx.agentId, 'pi');
});
