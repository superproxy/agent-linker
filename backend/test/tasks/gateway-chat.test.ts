import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat } from '../../src/channels/gateway-chat.js';

async function withMockGateway(
  fn: (url: string, seen: { bodies: Record<string, unknown>[] }) => Promise<void>,
): Promise<void> {
  const seen = { bodies: [] as Record<string, unknown>[] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.bodies.push(JSON.parse(raw) as Record<string, unknown>);
      // 返回一个 SSE 流
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('streamChat 携带 channel/agent/userId/task 参数', async () => {
  await withMockGateway(async (url, seen) => {
    const out = await streamChat({
      gatewayUrl: url,
      model: 'agent:opencode',
      sessionKey: 'weixin:wx_1:task:t_9',
      channel: 'weixin',
      agent: 'pi',
      userId: 'wx_1',
      task: 't_9',
      message: '你好',
    });
    assert.equal(out.text, 'hi');
    const body = seen.bodies[0];
    assert.equal(body.agent, 'pi');
    assert.equal(body.userId, 'wx_1');
    assert.equal(body.task, 't_9');
    assert.equal(body.channel, 'weixin');
    assert.equal(body.sessionKey, 'weixin:wx_1:task:t_9');
  });
});

test('streamChat 缺省不携带任务字段（兼容旧调用）', async () => {
  await withMockGateway(async (url, seen) => {
    await streamChat({ gatewayUrl: url, model: 'agent:opencode', sessionKey: 'k', message: 'hi' });
    const body = seen.bodies[0];
    assert.equal(body.agent, undefined);
    assert.equal(body.userId, undefined);
    assert.equal(body.task, undefined);
    assert.equal(body.channel, undefined);
    assert.equal(body.sessionKey, 'k');
  });
});
