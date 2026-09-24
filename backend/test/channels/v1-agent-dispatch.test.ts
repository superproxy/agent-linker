import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseSessionRouting, createV1AgentDispatch } from '../../src/channels/v1-agent-dispatch.js';
import type { UserTokenProvider } from '../../src/channels/user-token.js';

test('parseSessionRouting：OpenClaw direct 会话', () => {
  const r = parseSessionRouting('agent:pi:wecom:default:direct:zhangsan');
  assert.equal(r.channel, 'wecom');
  assert.equal(r.userId, 'zhangsan');
});

test('parseSessionRouting：legacy feishu / lark 前缀', () => {
  const f = parseSessionRouting('feishu:ou_abc');
  assert.equal(f.channel, 'feishu');
  assert.equal(f.userId, 'ou_abc');
  const l = parseSessionRouting('lark:ou_xyz');
  assert.equal(l.channel, 'feishu');
  assert.equal(l.userId, 'ou_xyz');
});

test('parseSessionRouting：legacy wecom 前缀', () => {
  const r = parseSessionRouting('wecom:zhangsan');
  assert.equal(r.channel, 'wecom');
  assert.equal(r.userId, 'zhangsan');
  assert.equal(r.legacySessionKey, 'wecom:zhangsan');
});

test('parseSessionRouting：未知格式回落 legacy', () => {
  const r = parseSessionRouting('custom-main');
  assert.equal(r.legacySessionKey, 'custom-main');
  assert.equal(r.channel, undefined);
});

test('parseSessionRouting：OpenClaw 会话不含 agent:pi 也可解析 wecom userId', () => {
  const r = parseSessionRouting('agent:hermes:wecom:default:direct:lisi');
  assert.equal(r.channel, 'wecom');
  assert.equal(r.userId, 'lisi');
});

test('createV1AgentDispatch：任务路由使用 UserTokenProvider 的 ct_', async () => {
  const seen = { auth: '', owner: '' };
  const server = createServer((req, res) => {
    seen.auth = req.headers.authorization ?? '';
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { ownerUsername?: string };
      seen.owner = body.ownerUsername ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const provider: UserTokenProvider = {
    async resolve(channel, userId) {
      assert.equal(channel, 'wecom');
      assert.equal(userId, 'zhangsan');
      return 'ct_mock_token';
    },
  };
  try {
    const dispatch = createV1AgentDispatch({
      gatewayUrl: url,
      legacyModel: 'linkagent-task-routed',
      ownerUsername: 'admin',
      userTokenProvider: provider,
    });
    await dispatch.chat(
      {
        agentId: 'pi',
        sessionKey: 'agent:pi:wecom:default:direct:zhangsan',
        accountId: 'default',
        text: 'hi',
      },
      { onText: () => {} },
    );
    assert.equal(seen.auth, 'Bearer ct_mock_token');
    assert.equal(seen.owner, 'admin');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
