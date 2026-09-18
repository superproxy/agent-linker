import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { NodeManager, type NodeManagerOptions } from '../../src/gateway/nodes/manager.js';
import { createNodeRegistry } from '../../src/gateway/nodes/store.js';
import { NodeTokenStore } from '../../src/gateway/users/node-token-store.js';
import type { GatewayToNode, NodeToGateway } from '@linkagent/shared';

interface Harness {
  manager: NodeManager;
  url: string;
  server: Server;
  dispose: () => Promise<void>;
}

async function startManager(
  expectedToken = '',
  extra: Pick<NodeManagerOptions, 'resolveNodeToken' | 'bindNodeToken'> = {},
): Promise<Harness> {
  const manager = new NodeManager({
    registry: createNodeRegistry(mkdtempSync(join(tmpdir(), 'linkagent-admission-'))),
    ...(expectedToken ? { expectedToken } : {}),
    ...extra,
    pingIntervalMs: 60_000,
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
  return { type: 'hello', name: 'apply-node', agents: [{ id: 'pi' }], ...extra };
}

interface Welcome {
  nodeId: string;
  approved: boolean;
  secret?: string;
}

/** 建立连接并等待 welcome，返回握手结果与 ws */
function connect(url: string, msg: NodeToGateway, opts: { token?: string } = {}): Promise<{ ws: WebSocket; w: Welcome }> {
  const full = opts.token ? `${url}?token=${encodeURIComponent(opts.token)}` : url;
  const ws = new WebSocket(full);
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as GatewayToNode;
      if (m.type === 'welcome') resolve({ ws, w: { nodeId: m.nodeId, approved: m.approved, secret: m.secret } });
    });
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket, predicate: (m: GatewayToNode) => boolean): Promise<GatewayToNode> {
  return new Promise((resolve, reject) => {
    ws.on('message', function on(raw) {
      const m = JSON.parse(raw.toString()) as GatewayToNode;
      if (predicate(m)) {
        ws.off('message', on);
        resolve(m);
      }
    });
    ws.on('error', reject);
  });
}

test('开启鉴权但匿名连接：进入待审批，不可路由；批准后就地上线并下发 approved', async () => {
  const h = await startManager('secret');
  const events: Array<[string, boolean]> = [];
  h.manager.onChange((id, online) => events.push([id, online]));

  const { ws, w } = await connect(h.url, hello({ nodeId: 'apply-1' }));
  assert.equal(w.approved, false);
  assert.ok(w.secret && w.secret.length > 16, '应签发节点 secret');
  assert.equal(h.manager.isOnline('apply-1'), false, '待审批不算在线');
  assert.equal(h.manager.getLink('apply-1'), undefined);
  assert.deepEqual(events, [], '待审批不触发上下线事件');
  const pendingInfo = h.manager.list().find((n) => n.nodeId === 'apply-1');
  assert.equal(pendingInfo?.status, 'pending');
  assert.equal(pendingInfo?.online, false);

  // 批准：连接就地升级
  const updated = h.manager.approveNode('apply-1');
  assert.equal(updated.status, 'approved');
  assert.equal(updated.online, true);
  assert.equal(h.manager.isOnline('apply-1'), true);
  assert.deepEqual(h.manager.onlineAgentIds('apply-1'), ['pi']);
  assert.deepEqual(events, [['apply-1', true]]);

  const msg = await nextMessage(ws, (m) => m.type === 'approved');
  assert.equal(msg.type, 'approved');

  ws.close();
  await h.dispose();
});

test('待审批节点凭 secret 重连：仍 pending 时继续等待；批准后再次重连直接上线', async () => {
  const h = await startManager('secret');
  const first = await connect(h.url, hello({ nodeId: 'apply-2' }));
  assert.equal(first.w.approved, false);
  const secret = first.w.secret!;
  first.ws.close();
  await new Promise((r) => setTimeout(r, 30));

  // 用 secret 重连（不带静态令牌）：仍 pending
  const second = await connect(h.url, hello({ nodeId: 'apply-2', secret }));
  assert.equal(second.w.approved, false);
  assert.equal(h.manager.isOnline('apply-2'), false);
  second.ws.close();
  await new Promise((r) => setTimeout(r, 30));

  // 离线批准
  h.manager.approveNode('apply-2');
  // 再凭 secret 重连：直接上线
  const third = await connect(h.url, hello({ nodeId: 'apply-2', secret }));
  assert.equal(third.w.approved, true);
  assert.equal(h.manager.isOnline('apply-2'), true);
  third.ws.close();
  await h.dispose();
});

test('拒绝：待审批连接收到 rejected 并关闭；记录置 blocked；secret 重连再被拒', async () => {
  const h = await startManager('secret');
  const { ws, w } = await connect(h.url, hello({ nodeId: 'apply-3' }));
  assert.equal(w.approved, false);

  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  h.manager.rejectNode('apply-3');
  await closed;
  assert.equal(h.manager.isOnline('apply-3'), false);
  assert.equal(h.manager.list().find((n) => n.nodeId === 'apply-3')?.status, 'blocked');

  // blocked 节点凭 secret 重连 → 收到 rejected 后被关
  const ws2 = new WebSocket(h.url);
  const rejected = new Promise<void>((resolve, reject) => {
    ws2.on('open', () => ws2.send(JSON.stringify(hello({ nodeId: 'apply-3', secret: w.secret }))));
    ws2.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as GatewayToNode;
      if (m.type === 'rejected') resolve();
    });
    ws2.on('error', reject);
  });
  await rejected;
  ws2.terminate();
  await h.dispose();
});

test('持正确静态令牌：匿名网关开启鉴权下也直连上线；错误令牌在 upgrade 阶段 401', async () => {
  const h = await startManager('secret');
  const ok = await connect(h.url, hello({ nodeId: 'direct-1' }), { token: 'secret' });
  assert.equal(ok.w.approved, true);
  assert.ok(ok.w.secret, '令牌直连也签发 secret 供日后免令牌重连');
  assert.equal(h.manager.isOnline('direct-1'), true);
  ok.ws.close();

  await new Promise<void>((resolve) => {
    const bad = new WebSocket(`${h.url}?token=wrong`);
    bad.on('error', (e) => {
      assert.match(e.message, /401/);
      try { bad.terminate(); } catch {}
      resolve();
    });
  });
  await h.dispose();
});

test('未开启鉴权：所有连接自动批准（兼容内网单机）', async () => {
  const h = await startManager('');
  const { ws, w } = await connect(h.url, hello({ nodeId: 'open-1' }));
  assert.equal(w.approved, true);
  assert.equal(h.manager.isOnline('open-1'), true);
  ws.close();
  await h.dispose();
});

test('匿名申请冒名已存在的 nodeId：网关注发新身份', async () => {
  const h = await startManager('secret');
  const legit = await connect(h.url, hello({ nodeId: 'taken' }));
  assert.equal(legit.w.nodeId, 'taken');

  const evil = await connect(h.url, hello({ nodeId: 'taken', name: 'fake' }));
  assert.notEqual(evil.w.nodeId, 'taken', '不能冒名已注册节点');
  assert.match(evil.w.nodeId, /^n_[0-9a-f]{12}$/);
  legit.ws.close();
  evil.ws.close();
  await h.dispose();
});

test('用户机器 token（nt_）与网关静态 token 均可直连上线；错误 nt_ 在 upgrade 阶段 401', async () => {
  const tokens = new NodeTokenStore(mkdtempSync(join(tmpdir(), 'linkagent-nt-admit-')));
  const rec = tokens.issue('alice', 'pc');
  const h = await startManager('gateway-secret', {
    resolveNodeToken: (t) => {
      const r = tokens.resolve(t);
      return r ? { username: r.username, ...(r.nodeId ? { nodeId: r.nodeId } : {}) } : null;
    },
    bindNodeToken: (t, nodeId) => tokens.bindNode(t, nodeId),
  });

  const byNt = await connect(h.url, hello({ nodeId: 'alice-pc' }), { token: rec.token });
  assert.equal(byNt.w.approved, true);
  assert.equal(h.manager.isOnline('alice-pc'), true);
  assert.equal(h.manager.list().find((n) => n.nodeId === 'alice-pc')?.ownerUsername, 'alice');
  byNt.ws.close();

  const byGw = await connect(h.url, hello({ nodeId: 'gw-box' }), { token: 'gateway-secret' });
  assert.equal(byGw.w.approved, true);
  assert.equal(h.manager.isOnline('gw-box'), true);
  byGw.ws.close();

  await new Promise<void>((resolve) => {
    const bad = new WebSocket(`${h.url}?token=${encodeURIComponent('nt_deadbeef')}`);
    bad.on('error', (e) => {
      assert.match(e.message, /401/);
      try {
        bad.terminate();
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
  await h.dispose();
});

test('机器 token 绑定后不可用于另一台机器', async () => {
  const tokens = new NodeTokenStore(mkdtempSync(join(tmpdir(), 'linkagent-nt-bind-')));
  const rec = tokens.issue('alice');
  const h = await startManager('gateway-secret', {
    resolveNodeToken: (t) => {
      const r = tokens.resolve(t);
      return r ? { username: r.username, ...(r.nodeId ? { nodeId: r.nodeId } : {}) } : null;
    },
    bindNodeToken: (t, nodeId) => tokens.bindNode(t, nodeId),
  });

  const first = await connect(h.url, hello({ nodeId: 'n_one' }), { token: rec.token });
  assert.equal(first.w.approved, true);
  first.ws.close();
  await new Promise((r) => setTimeout(r, 30));

  const ws2 = new WebSocket(`${h.url}?token=${encodeURIComponent(rec.token)}`);
  const closed = new Promise<number>((resolve, reject) => {
    ws2.on('open', () => ws2.send(JSON.stringify(hello({ nodeId: 'n_two' }))));
    ws2.on('close', (code) => resolve(code));
    ws2.on('error', reject);
  });
  assert.equal(await closed, 4401);
  await h.dispose();
});

test('非 pending 状态不能批准；不存在节点批准抛错', async () => {
  const h = await startManager('');
  await connect(h.url, hello({ nodeId: 'already' }));
  assert.throws(() => h.manager.approveNode('already'), /不在待审批/);
  assert.throws(() => h.manager.approveNode('ghost'), /不存在/);
  await h.dispose();
});
