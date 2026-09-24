import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendChannelGatewayLog,
  clearChannelGatewayLogBuffer,
  snapshotChannelGatewayLogs,
} from '../../src/channels/channel-gateway-log-buffer.js';

test('channel-gateway 日志环保留最近行', () => {
  clearChannelGatewayLogBuffer();
  for (let i = 0; i < 10; i += 1) appendChannelGatewayLog('info', `line-${i}`);
  const snap = snapshotChannelGatewayLogs(3);
  assert.equal(snap.length, 3);
  assert.match(snap[0] ?? '', /line-7/);
  assert.match(snap[2] ?? '', /line-9/);
});
