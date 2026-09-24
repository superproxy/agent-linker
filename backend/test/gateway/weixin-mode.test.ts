import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelGatewayFromWeixinMode,
  migrateConfig,
  normalizeWeixinMode,
  weixinModeFromChannelGateway,
} from '@linkagent/shared';

test('normalizeWeixinMode：raw / claw 与旧值映射', () => {
  assert.equal(normalizeWeixinMode('raw'), 'raw');
  assert.equal(normalizeWeixinMode('claw'), 'claw');
  assert.equal(normalizeWeixinMode('external'), 'raw');
  assert.equal(normalizeWeixinMode('weixin-bot'), 'raw');
  assert.equal(normalizeWeixinMode('openclaw-weixin-plugin'), 'claw');
  assert.equal(normalizeWeixinMode(''), 'raw');
});

test('channelGatewayFromWeixinMode / weixinModeFromChannelGateway', () => {
  assert.deepEqual(channelGatewayFromWeixinMode('raw'), { weixin: true, weixinPlugin: false });
  assert.deepEqual(channelGatewayFromWeixinMode('claw'), { weixin: true, weixinPlugin: true });
  assert.equal(weixinModeFromChannelGateway(true, false), 'raw');
  assert.equal(weixinModeFromChannelGateway(true, true), 'claw');
  assert.equal(weixinModeFromChannelGateway(false, false), null);
});

test('migrateConfig：weixin.mode 旧 yaml 归一为 raw|claw', () => {
  const fromLegacy = migrateConfig({
    gateway: { server: { host: '127.0.0.1', port: 8787 }, auth: { mode: 'open' }, agents: [] },
    weixin: { mode: 'openclaw-weixin-plugin' },
    channelGateway: { enabled: false },
    node: { enabled: false, agents: [] },
  });
  assert.equal(fromLegacy.weixin.mode, 'claw');

  const fromExternal = migrateConfig({
    gateway: { server: { host: '127.0.0.1', port: 8787 }, auth: { mode: 'open' }, agents: [] },
    weixin: { mode: 'external' },
    channelGateway: { enabled: false },
    node: { enabled: false, agents: [] },
  });
  assert.equal(fromExternal.weixin.mode, 'raw');
});
