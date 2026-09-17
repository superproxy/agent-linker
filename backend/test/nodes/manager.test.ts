import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { NodeManager } from '../../src/gateway/nodes/manager.js';
import { createNodeRegistry } from '../../src/gateway/nodes/store.js';
import { NodeOfflineError } from '../../src/gateway/nodes/link.js';
import type { GatewayToNode, NodeToGateway } from '@linkagent/shared';

interface Harness {
  manager: NodeManager;
  url: string;
  server: Server;
  dispose: () => Promise<void>;
}

async function startManager(expectedToken = '', pingIntervalMs = 60_000): Promise<Harness> {
  const manager = new NodeManager({
    registry: createNodeRegistry(mkdtempSync(join(tmpdir(), 'linkagent-nodes-'))),
    ...(expectedToken ? { expectedToken } : {}),
    pingIntervalMs,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => manager.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    manager,
    url: `ws://127.0.0.1:${port}/api/nodes/ws`,
    server,
    dispose: async () => {
      await manager.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function hello(extra: Partial<Extract<NodeToGateway, { type: 'hello' }>> = {}): NodeToGateway {
  return { type: 'hello', name: 'test-node', agents: [{ id: 'pi', displayName: 'Pi' }], ...extra };
}

/** 建立节点连接并完成 hello/welcome 握手，返回已发 welcome 的 nodeId */
function connectAndHandshake(
  url: string,
  msg: NodeToGateway,
  opts: { token?: string } = {},
): Promise<{ ws: WebSocket; nodeId: string }> {
  // 先建 ws 再包 Promise：被服务端拒绝（401）时 error 可能在 executor 返回前触发，
  // 监听器必须在 new WebSocket 同一同步执行栈内挂好，否则变成 uncaughtException 挂起进程。
  // token 走 query（ws 客户端第二参数是子协议，不能传 headers 对象）。
  const full = opts.token ? `${url}?token=${encodeURIComponent(opts.token)}` : url;
  const ws = new WebSocket(full);
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as GatewayToNode;
      if (m.type === 'welcome') resolve({ ws, nodeId: m.nodeId });
    });
    ws.on('error', reject);
  });
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.on('close', () => resolve()));
}

test('hello 握手：节点上线、注册落盘、change 监听触发、list 在线', async () => {
  const h = await startManager();
  const events: Array<[string, boolean]> = [];
  h.manager.onChange((id, online) => events.push([id, online]));
  const { ws, nodeId } = await connectAndHandshake(h.url, hello({ nodeId: 'node-a' }));

  assert.equal(nodeId, 'node-a');
  assert.ok(h.manager.isOnline('node-a'));
  assert.deepEqual(h.manager.onlineAgentIds('node-a'), ['pi']);
  const info = h.manager.list().find((n) => n.nodeId === 'node-a');
  assert.ok(info?.online);
  assert.equal(info?.name, 'test-node');
  assert.deepEqual(events, [['node-a', true]]);
  assert.ok(h.manager.getLink('node-a'));

  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.manager.isOnline('node-a'), false);
  assert.deepEqual(events.at(-1), ['node-a', false]);
  // 注册记录保留（离线仍可见）
  assert.equal(h.manager.list().find((n) => n.nodeId === 'node-a')?.online, false);
  await h.dispose();
});

test('未带 nodeId 时网关签发 n_ 前缀 id；非法 id 同样重新签发', async () => {
  const h = await startManager();
  const a = await connectAndHandshake(h.url, hello({ nodeId: undefined }));
  assert.match(a.nodeId, /^n_[0-9a-f]{12}$/);
  const b = await connectAndHandshake(h.url, hello({ nodeId: 'bad/id 空格' }));
  assert.match(b.nodeId, /^n_[0-9a-f]{12}$/);
  a.ws.close(); b.ws.close();
  await h.dispose();
});

test('鉴权：错误 token 被拒（401 升级失败 / hello 4401），正确 token 通过', async () => {
  const h = await startManager('secret');
  // 错误 query token → upgrade 401，连接打不开
  await new Promise<void>((resolve) => {
    const bad = new WebSocket(`${h.url}?token=wrong`);
    bad.on('error', (e) => {
      assert.match(e.message, /401/);
      try { bad.terminate(); } catch {}
      resolve();
    });
  });
  // 正确 query token → upgrade 通过 + hello 成功
  const ok = await connectAndHandshake(`${h.url}?token=secret`, hello({ nodeId: 'n-ok', token: 'secret' }));
  assert.ok(h.manager.isOnline('n-ok'));
  // upgrade 不带 token（匿名）、hello 带错误 token → 服务端以 4401 正常关闭帧拒绝
  const badWs = new WebSocket(h.url);
  const badHello = new Promise<void>((resolve, reject) => {
    badWs.on('open', () => badWs.send(JSON.stringify(hello({ nodeId: 'n-bad', token: 'nope' }))));
    badWs.on('close', (code) => (code === 4401 ? resolve() : reject(new Error(`code=${code}`))));
    badWs.on('error', () => {});
  });
  await badHello;
  try { badWs.terminate(); } catch {}
  ok.ws.close();
  await h.dispose();
});

test('同 nodeId 重连：旧连接被替换，旧连接 close 不误删新连接', async () => {
  const h = await startManager();
  const first = await connectAndHandshake(h.url, hello({ nodeId: 'dup' }));
  const oldClosed = closed(first.ws);
  const second = await connectAndHandshake(h.url, hello({ nodeId: 'dup', name: 'renamed', agents: [{ id: 'codex' }] }));
  await oldClosed;
  // 等旧连接的 close 事件被 manager 处理
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(h.manager.isOnline('dup'), '新连接必须仍在线（旧连接 close 不能误删）');
  assert.deepEqual(h.manager.onlineAgentIds('dup'), ['codex']);
  assert.equal(h.manager.list().find((n) => n.nodeId === 'dup')?.name, 'renamed');
  second.ws.close();
  await h.dispose();
});

test('turn 多路复用：网关下发 turn，节点回 turnEvent/turnResult，runTurn 收敛结果', async () => {
  const h = await startManager();
  const { ws, nodeId } = await connectAndHandshake(h.url, hello({ nodeId: 't1' }));
  const received: GatewayToNode[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as GatewayToNode;
    if (m.type !== 'welcome') received.push(m);
    if (m.type === 'turn') {
      ws.send(JSON.stringify({ type: 'turnEvent', requestId: m.requestId, event: { kind: 'text', text: '你好' } }));
      ws.send(JSON.stringify({ type: 'turnEvent', requestId: m.requestId, event: { kind: 'tool', name: 'read' } }));
      ws.send(JSON.stringify({ type: 'turnResult', requestId: m.requestId, result: { status: 'completed', sessionId: 's1' } }));
    }
  });

  const events: string[] = [];
  const link = h.manager.getLink(nodeId);
  assert.ok(link);
  const result = await link!.runTurn(
    { agentId: 'pi', text: 'hi', sessionKey: 'k1' },
    (ev) => events.push(ev.kind),
  );
  assert.deepEqual(result, { status: 'completed', sessionId: 's1' });
  assert.deepEqual(events, ['text', 'tool']);
  const turn = received.find((m) => m.type === 'turn');
  assert.equal(turn?.type === 'turn' && turn.agentId, 'pi');
  assert.equal(turn?.type === 'turn' && turn.sessionKey, 'k1');

  ws.close();
  await h.dispose();
});

test('turnError：节点执行失败时 runTurn reject', async () => {
  const h = await startManager();
  const { ws, nodeId } = await connectAndHandshake(h.url, hello({ nodeId: 't2' }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as GatewayToNode;
    if (m.type === 'turn') {
      ws.send(JSON.stringify({ type: 'turnError', requestId: m.requestId, message: 'agent 崩了' }));
    }
  });
  await assert.rejects(
    () => h.manager.getLink(nodeId)!.runTurn({ agentId: 'pi', text: 'x' }, () => {}),
    /agent 崩了/,
  );
  ws.close();
  await h.dispose();
});

test('abort：取消时发 cancel 且 runTurn reject', async () => {
  const h = await startManager();
  const { ws, nodeId } = await connectAndHandshake(h.url, hello({ nodeId: 't3' }));
  let resolveTurnReceived!: () => void;
  let resolveCancelReceived!: () => void;
  const turnReceived = new Promise<void>((r) => { resolveTurnReceived = r; });
  const cancelReceived = new Promise<void>((r) => { resolveCancelReceived = r; });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as GatewayToNode;
    if (m.type === 'welcome') return;
    if (m.type === 'turn') resolveTurnReceived();
    if (m.type === 'cancel') resolveCancelReceived();
  });
  const ac = new AbortController();
  const p = h.manager.getLink(nodeId)!.runTurn({ agentId: 'pi', text: 'long' }, () => {}, ac.signal);
  await turnReceived; // 确保节点已收到 turn 后再取消
  ac.abort();
  await assert.rejects(p, /请求已取消/);
  await cancelReceived; // cancel 经网络到达客户端（I/O 事件，晚于 reject 微任务）
  ws.close();
  await h.dispose();
});

test('节点离线：进行中的 turn 以 NodeOfflineError reject', async () => {
  const h = await startManager();
  const { ws, nodeId } = await connectAndHandshake(h.url, hello({ nodeId: 't4' }));
  const p = h.manager.getLink(nodeId)!.runTurn({ agentId: 'pi', text: 'long2' }, () => {});
  ws.close();
  await assert.rejects(p, (e: Error) => e instanceof NodeOfflineError);
  await h.dispose();
});

test('removeNode：在线拒删(409 语义)、不存在抛错、离线记录可删', async () => {
  const h = await startManager();
  const { ws } = await connectAndHandshake(h.url, hello({ nodeId: 'rm1' }));
  assert.throws(() => h.manager.removeNode('rm1'), /在线/);
  assert.throws(() => h.manager.removeNode('ghost'), /不存在/);
  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  h.manager.removeNode('rm1');
  assert.equal(h.manager.list().some((n) => n.nodeId === 'rm1'), false);
  await h.dispose();
});

test('非 /api/nodes/ws 路径的 upgrade 返回 404', async () => {
  const h = await startManager();
  const badUrl = h.url.replace('/api/nodes/ws', '/other');
  await new Promise<void>((resolve) => {
    const bad = new WebSocket(badUrl);
    bad.on('error', (e) => {
      assert.match(e.message, /404/);
      try { bad.terminate(); } catch {}
      resolve();
    });
  });
  await h.dispose();
});
