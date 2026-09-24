import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChannelGatewayRuntimeReport,
  setChannelGatewayRuntimeReport,
} from '../../src/gateway/channels/runtime-report-store.js';

test('channel-gateway 运行态：set/get 快照', () => {
  setChannelGatewayRuntimeReport({
    reportedAt: 1,
    service: 'channel-gateway',
    weixinBotCount: 2,
    pluginAccounts: [{ key: 'wecom:default', running: true, lastError: null }],
    http: { exposePluginRoutes: false, listen: '127.0.0.1:8790' },
  });
  const r = getChannelGatewayRuntimeReport();
  assert.ok(r);
  assert.equal(r?.weixinBotCount, 2);
  assert.equal(r?.pluginAccounts[0]?.key, 'wecom:default');
});
