import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_NODE_ID, type NodeInfo } from '@linkagent/shared';
import { AgentManager } from '../../src/gateway/agents/manager.js';
import { RemoteNodeAdapter } from '../../src/gateway/agents/remoteWrapper.js';
import { NodeOfflineError, type NodeLink, type RemoteTurnRequest } from '../../src/gateway/nodes/link.js';
import type { NodeManager } from '../../src/gateway/nodes/manager.js';
import type { NodeTurnEvent, NodeTurnResult } from '@linkagent/shared';

/** 内存假 NodeManager：只实现 AgentManager 依赖的查询面 */
function fakeNodeManager(state: { online: boolean; agents: Array<{ id: string; displayName?: string }>; nodes?: NodeInfo[] }): NodeManager {
  const link: NodeLink = {
    nodeId: 'n1',
    get online() { return state.online; },
    runTurn: (req: RemoteTurnRequest, onEvent: (ev: NodeTurnEvent) => void) => fakeRunTurn(req, onEvent),
  };
  const nodes: NodeInfo[] = state.nodes ?? [
    { nodeId: 'n1', name: 'node-1', online: state.online, agents: state.agents },
  ];
  return {
    list: () => nodes,
    isOnline: (id) => (id === 'n1' ? state.online : false),
    getLink: (id) => (id === 'n1' && state.online ? link : undefined),
    onlineAgentIds: (id) => (id === 'n1' && state.online ? state.agents.map((a) => a.id) : []),
    onChange: () => () => {},
  } as unknown as NodeManager;
}

let fakeRunTurn: (req: RemoteTurnRequest, onEvent: (ev: NodeTurnEvent) => void) => Promise<NodeTurnResult> =
  async () => ({ status: 'completed' });

function freshManager(nodeManager?: NodeManager): AgentManager {
  // 用最小定义，避免依赖本机安装的 agent CLI（start 只 new AcpWrapper，不 spawn）
  const definitions = [
    { id: 'opencode', type: 'opencode' as const, displayName: 'OpenCode', description: 'local' },
    { id: 'pi', type: 'pi' as const, displayName: 'Pi', description: 'local' },
  ];
  return new AgentManager({
    definitions,
    stateDir: mkdtempSync(join(tmpdir(), 'linkagent-routing-')),
    repoRoot: process.cwd(),
    ...(nodeManager ? { nodeManager } : {}),
  });
}

test('resolveForRouting：local agent 正常/停用/未知', async () => {
  const m = freshManager();
  await m.start();
  assert.equal(m.resolveForRouting(LOCAL_NODE_ID, 'opencode').kind, 'ok');
  assert.equal(m.resolveForRouting(undefined, 'opencode').kind, 'ok', 'nodeId 缺省回落 local');
  m.updateAgent('pi', { enabled: false });
  assert.equal(m.resolveForRouting('local', 'pi').kind, 'unknown');
  assert.equal(m.resolveForRouting('local', 'ghost').kind, 'unknown');
  assert.equal(m.hasRoutingAgent('local', 'opencode'), true);
  assert.equal(m.hasRoutingAgent('local', 'pi'), false);
  await m.dispose();
});

test('resolveForRouting：远程节点离线→offline；在线未自报 agent→unknown；在线且自报→ok', async () => {
  const online = freshManager(fakeNodeManager({ online: true, agents: [{ id: 'codex', displayName: 'Codex' }] }));
  await online.start();
  const ok = online.resolveForRouting('n1', 'codex');
  assert.equal(ok.kind, 'ok');
  assert.equal(online.resolveForRouting('n1', 'opencode').kind, 'unknown', '节点未自报该 agent');
  assert.equal(online.hasRoutingAgent('n1', 'codex'), true);

  const offline = freshManager(fakeNodeManager({ online: false, agents: [{ id: 'codex' }] }));
  await offline.start();
  const r = offline.resolveForRouting('n1', 'codex');
  assert.equal(r.kind, 'offline');
  if (r.kind === 'offline') assert.equal(r.nodeId, 'n1');
  await Promise.all([online.dispose(), offline.dispose()]);
});

test('listRoutingAgents：local 全量 + 仅在线远程节点的自报 agent', async () => {
  const m = freshManager(
    fakeNodeManager({
      online: true,
      agents: [{ id: 'codex', displayName: 'Codex' }],
      nodes: [
        { nodeId: 'n1', name: 'node-1', online: true, agents: [{ id: 'codex', displayName: 'Codex' }] },
        { nodeId: 'n2', name: 'node-2', online: false, agents: [{ id: 'pi' }] },
      ],
    }),
  );
  await m.start();
  const all = m.listRoutingAgents();
  assert.ok(all.some((a) => a.nodeId === 'local' && a.agentId === 'opencode'));
  assert.ok(all.some((a) => a.nodeId === 'n1' && a.agentId === 'codex' && a.online));
  assert.ok(!all.some((a) => a.nodeId === 'n2'), '离线节点 agent 不应出现在可路由列表');
  await m.dispose();
});

test('节点上下线 change 回调驱动远程适配器增删', async () => {
  let listener: (nodeId: string, online: boolean) => void = () => {};
  const state = { online: true, agents: [{ id: 'codex', displayName: 'Codex' }] };
  const nm = fakeNodeManager(state) as unknown as NodeManager;
  (nm as unknown as { onChange: (fn: typeof listener) => () => void }).onChange = (fn) => { listener = fn; return () => {}; };
  const m = freshManager(nm);
  await m.start();
  assert.equal(m.resolveForRouting('n1', 'codex').kind, 'ok');
  state.online = false;
  listener('n1', false);
  assert.equal(m.resolveForRouting('n1', 'codex').kind, 'offline');
  state.online = true;
  listener('n1', true);
  assert.equal(m.resolveForRouting('n1', 'codex').kind, 'ok');
  await m.dispose();
});

test('RemoteNodeAdapter：在线时事件映射 + 结果透传；离线直接抛 NodeOfflineError', async () => {
  const events: NodeTurnEvent[] = [];
  fakeRunTurn = async (req, onEvent) => {
    assert.equal(req.agentId, 'pi');
    assert.equal(req.text, '你好');
    onEvent({ kind: 'text', text: '答' });
    onEvent({ kind: 'thought', text: '想' });
    onEvent({ kind: 'tool', name: 'bash' });
    return { status: 'completed', sessionId: 's-1' };
  };
  let online = true;
  const link: NodeLink = {
    nodeId: 'n1',
    get online() { return online; },
    runTurn: (req, cb) => fakeRunTurn(req, cb),
  };
  const adapter = new RemoteNodeAdapter('n1', 'pi', link, 'Pi');
  assert.equal(adapter.id, 'pi');
  assert.equal(adapter.nodeId, 'n1');
  const cbs: string[] = [];
  const res = await adapter.chat(
    { messages: [{ role: 'user', content: '你好' }], sessionKey: 'k', cwd: '/tmp' },
    {
      onText: (d) => cbs.push(`text:${d}`),
      onReasoning: (d) => cbs.push(`thought:${d}`),
      onToolActivity: (n) => cbs.push(`tool:${n}`),
      onSessionId: () => {},
    },
  );
  assert.deepEqual(cbs, ['text:答', 'thought:想', 'tool:bash']);
  assert.equal(res.sessionId, 's-1');
  assert.equal(events.length, 0);

  // failed 结果 → throw
  fakeRunTurn = async () => ({ status: 'failed', error: { message: 'boom' } });
  await assert.rejects(() => adapter.chat({ messages: [{ role: 'user', content: 'x' }] }, { onText: () => {} }), /boom/);

  // 离线 → NodeOfflineError
  online = false;
  await assert.rejects(
    () => adapter.chat({ messages: [{ role: 'user', content: 'x' }] }, { onText: () => {} }),
    (e: Error) => e instanceof NodeOfflineError && e.code === 'node_offline',
  );
});

test('RemoteNodeAdapter：空 user 文本直接报错（不发起远程 turn）', async () => {
  let called = false;
  const link: NodeLink = {
    nodeId: 'n1',
    online: true,
    runTurn: async () => { called = true; return { status: 'completed' }; },
  };
  const adapter = new RemoteNodeAdapter('n1', 'pi', link);
  await assert.rejects(
    () => adapter.chat({ messages: [{ role: 'assistant', content: '只有 assistant' }] }, { onText: () => {} }),
    /没有可发送的 user 文本/,
  );
  assert.equal(called, false);
});
