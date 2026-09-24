import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendGatewayDispatchTraceRaw,
  clearGatewayDispatchTraceForTest,
  emitChannelDispatchTrace,
  emitGatewayDispatchTrace,
  formatDispatchTraceLine,
  setChannelDispatchTraceSink,
  snapshotGatewayDispatchTrace,
} from '../../src/store/dispatch-trace.js';

test('formatDispatchTraceLine 与 gateway 环缓冲', () => {
  clearGatewayDispatchTraceForTest();
  const line = formatDispatchTraceLine('gateway.v1.recv', { traceId: 'abc', channel: 'wecom', userId: 'u1' });
  assert.match(line, /^step=gateway\.v1\.recv/);
  assert.match(line, /traceId=abc/);
  emitGatewayDispatchTrace('gateway.routing', { traceId: 'abc', kind: 'chat' });
  const snap = snapshotGatewayDispatchTrace(10);
  assert.equal(snap.length, 1);
  assert.match(snap[0] ?? '', /gateway\.routing/);
});

test('emitChannelDispatchTrace 走 sink', () => {
  clearGatewayDispatchTraceForTest();
  const seen: string[] = [];
  setChannelDispatchTraceSink((line) => seen.push(line));
  emitChannelDispatchTrace('channels.inbound', { traceId: 't1', channel: 'weixin' });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /channels\.inbound/);
  appendGatewayDispatchTraceRaw(seen[0] ?? '');
  assert.equal(snapshotGatewayDispatchTrace(5).length, 1);
});
