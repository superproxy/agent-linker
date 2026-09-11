import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat, runChatSession } from '../../src/channels/gateway-chat.js';

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
    server.closeAllConnections();
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

/**
 * mock 网关：流式持续输出正文，直到发完所有块。
 * 注意：不要在 req 上注册 'close' 监听器——它会破坏 undici 客户端
 * 读取该响应的能力（node:test 下表现为 fetch 永远读不到数据）。
 */
async function withSlowStreamGateway(
  bodyChunks: string[],
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (i >= bodyChunks.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: bodyChunks[i] } }] })}\n\n`);
        i += 1;
      }, 5);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('runChatSession maxTextChars 达上限即中断并只返回前 N 字符', async () => {
  const sent: string[] = [];
  await withSlowStreamGateway(['aaaa', 'bbbb', 'cccc', 'dddd'], async (url) => {
    const out = await runChatSession({
      gatewayUrl: url,
      model: 'agent:opencode',
      message: 'hi',
      maxTextChars: 10,
      send: async (chunk) => {
        sent.push(chunk);
      },
      split: (t) => [t],
      log: () => {},
    });
    // 发送给用户的正文被精确截断到 10 字符
    assert.equal(sent.join('').length, 10);
    assert.ok(out.text.length <= 10, `out.text=${out.text}`);
    // 返回正文 = 发送正文，无错误前缀
    assert.equal(out.text, sent.join(''));
  });
});

test('runChatSession 不设 maxTextChars 时完整返回', async () => {
  const sent: string[] = [];
  await withSlowStreamGateway(['aaaa', 'bbbb', 'cccc', 'dddd'], async (url) => {
    const out = await runChatSession({
      gatewayUrl: url,
      model: 'agent:opencode',
      message: 'hi',
      send: async (chunk) => {
        sent.push(chunk);
      },
      split: (t) => [t],
      log: () => {},
    });
    assert.equal(out.text, 'aaaabbbbccccdddd');
    assert.equal(sent.join(''), 'aaaabbbbccccdddd');
  });
});
