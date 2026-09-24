import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import {
  persistWecomChannelSetup,
  readWecomConfigView,
  maskSecret,
} from '../../src/config/persist-wecom.js';

function writeSplit(dir: string): void {
  writeFileSync(
    join(dir, 'gateway.yaml'),
    'server:\n  host: 127.0.0.1\n  port: 8787\nauth:\n  mode: open\nagents: []\nplugins: []\nchannels: {}\n',
  );
  writeFileSync(join(dir, 'weixin.yaml'), 'enabled: false\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: false\nagents: []\n');
  writeFileSync(join(dir, 'channels.yaml'), 'channelGateway:\n  enabled: false\n');
}

test('persistWecomChannelSetup：只写 channels.yaml，不改 gateway.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-wecom-'));
  writeSplit(dir);
  const gatewayFile = join(dir, 'gateway.yaml');
  const gwBefore = readFileSync(gatewayFile, 'utf8');
  persistWecomChannelSetup(
    gatewayFile,
    { enabled: true, botId: 'my-bot', secret: 'sec-123', connectionMode: 'webhook' },
    { enabled: true, wecom: true, model: 'agent:pi' },
  );
  assert.equal(readFileSync(gatewayFile, 'utf8'), gwBefore);
  const chRaw = parse(readFileSync(join(dir, 'channels.yaml'), 'utf8')) as Record<string, unknown>;
  const cg = chRaw.channelGateway as Record<string, unknown>;
  assert.equal(cg.enabled, true);
  const channels = cg.channels as Record<string, unknown>;
  const wecom = channels.wecom as Record<string, unknown>;
  assert.equal(wecom.botId, 'my-bot');
  assert.equal(wecom.secret, 'sec-123');
  const view = readWecomConfigView(gatewayFile);
  assert.equal(view.wecom.enabled, true);
});

test('persistWecomChannelSetup：写入 wecomOwner 任务归属', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-wecom-owner-'));
  writeSplit(dir);
  const gatewayFile = join(dir, 'gateway.yaml');
  persistWecomChannelSetup(
    gatewayFile,
    { enabled: true, botId: 'b1', secret: 's1', connectionMode: 'websocket' },
    { enabled: true, wecom: true, wecomOwner: 'alice' },
  );
  const view = readWecomConfigView(gatewayFile);
  assert.equal(view.channelGateway.wecomOwner, 'alice');
});

test('maskSecret：未配置与已配置', () => {
  assert.equal(maskSecret('').configured, false);
  assert.match(maskSecret('abcdefgh').preview, /^ab…gh$/);
});
