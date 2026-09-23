import type { FastifyInstance } from 'fastify';
import { LOCAL_NODE_ID } from '@linkagent/shared';
import type { AgentManager } from '../agents/manager.js';
import type { PreferenceStore } from '../prefs/store.js';
import type { AuthCheck } from '../tasks/api.js';
import type { NodeManager } from './manager.js';
import { canSeeNode } from './visibility.js';

type Reply = { code(code: number): unknown };
type HeaderReq = { headers: Record<string, string | string[] | undefined> };

/**
 * 节点管理与用户偏好 REST：
 *   GET    /api/nodes                                  可见节点（管理员含本机+全部；其他人只看自己的远程机器）
 *   POST   /api/nodes/:nodeId/approve                  批准待审批节点（仅管理员）
 *   POST   /api/nodes/:nodeId/reject                   拒绝待审批节点（仅管理员）
 *   POST   /api/nodes/:nodeId/disable                  临时停用节点：在线则关闭连接，重连被拒（管理员或 nt_ 属主）
 *   POST   /api/nodes/:nodeId/enable                   恢复已停用节点（管理员或 nt_ 属主）
 *   DELETE /api/nodes/:nodeId                          删除离线/已停用节点（管理员或 nt_ 属主）
 *   GET    /api/users/:channel/:userId/preferences     用户默认节点+agent（仅预填，不鉴权）
 *   PUT    /api/users/:channel/:userId/preferences     保存用户默认节点+agent
 */
export function registerNodeApi(
  app: FastifyInstance,
  nodeManager: NodeManager,
  manager: AgentManager,
  prefs: PreferenceStore,
  checkAuth: AuthCheck,
  isAdmin: AuthCheck = checkAuth,
  sessionUser: (req: HeaderReq) => { username: string } | null = () => null,
): void {
  const requireAuth = (request: { headers: Record<string, string | string[] | undefined> }, reply: Reply): boolean => {
    if (checkAuth(request)) return true;
    reply.code(401);
    return false;
  };

  const requireAdmin = (request: { headers: Record<string, string | string[] | undefined> }, reply: Reply): boolean => {
    if (!checkAuth(request)) {
      reply.code(401);
      return false;
    }
    if (!isAdmin(request)) {
      reply.code(403);
      return false;
    }
    return true;
  };

  const viewerOf = (request: HeaderReq) => ({
    admin: isAdmin(request),
    username: sessionUser(request)?.username,
  });

  const canManageNode = (
    rec: { ownerUsername?: string },
    viewer: ReturnType<typeof viewerOf>,
  ): boolean => viewer.admin || (!!viewer.username && rec.ownerUsername === viewer.username);

  type ManageNodeGate = { ok: true } | { ok: false; status: 401 | 403 | 404 | 400; error: string };

  const manageNodeGate = (
    request: HeaderReq,
    rec: { ownerUsername?: string } | undefined,
    nodeId: string,
    localError: string,
  ): ManageNodeGate => {
    if (!checkAuth(request)) return { ok: false, status: 401, error: 'unauthorized' };
    if (nodeId === LOCAL_NODE_ID) return { ok: false, status: 400, error: localError };
    if (!rec) return { ok: false, status: 404, error: `节点不存在: ${nodeId}` };
    if (!canManageNode(rec, viewerOf(request))) return { ok: false, status: 403, error: '只能管理自己的机器' };
    return { ok: true };
  };

  app.get('/api/nodes', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const viewer = viewerOf(request);
    // 内建本机节点置顶，其后为在线/待审批/离线远程节点
    const local = {
      nodeId: LOCAL_NODE_ID,
      name: '本机（网关）',
      online: true,
      status: 'approved' as const,
      agents: manager.listAgentDetails().map((a) => ({ id: a.id, displayName: a.displayName })),
      connectedAt: undefined,
      lastSeenAt: Date.now(),
    };
    const remote = nodeManager.list().filter((n) => canSeeNode(n, viewer));
    return { nodes: viewer.admin ? [local, ...remote] : remote };
  });

  app.post('/api/nodes/:nodeId/approve', async (request, reply) => {
    if (!requireAdmin(request, reply)) return { error: 'forbidden' };
    const { nodeId } = request.params as { nodeId: string };
    if (nodeId === LOCAL_NODE_ID) return reply.code(400).send({ error: '内建本机节点无需审批' });
    try {
      return { node: nodeManager.approveNode(nodeId) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: msg });
    }
  });

  app.post('/api/nodes/:nodeId/reject', async (request, reply) => {
    if (!requireAdmin(request, reply)) return { error: 'forbidden' };
    const { nodeId } = request.params as { nodeId: string };
    if (nodeId === LOCAL_NODE_ID) return reply.code(400).send({ error: '内建本机节点不可拒绝' });
    const body = request.body as { reason?: string } | null | undefined;
    try {
      nodeManager.rejectNode(nodeId, body?.reason?.trim() || undefined);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /不存在/.test(msg) ? 404 : 409;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete('/api/nodes/:nodeId', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const rec = nodeManager.list().find((n) => n.nodeId === nodeId);
    const gate = manageNodeGate(request, rec, nodeId, '内建本机节点不可删除');
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });
    try {
      nodeManager.removeNode(nodeId);
      return { ok: true };
    } catch (err) {
      const code = /在线/.test(err instanceof Error ? err.message : String(err)) ? 409 : 404;
      return reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/nodes/:nodeId/disable', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const rec = nodeManager.list().find((n) => n.nodeId === nodeId);
    const gate = manageNodeGate(request, rec, nodeId, '内建本机节点不可停用');
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });
    const body = request.body as { reason?: string } | null | undefined;
    try {
      const node = nodeManager.disableNode(nodeId, body?.reason?.trim() || undefined);
      return { node };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /不存在/.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post('/api/nodes/:nodeId/enable', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const rec = nodeManager.list().find((n) => n.nodeId === nodeId);
    const gate = manageNodeGate(request, rec, nodeId, '内建本机节点不可启用');
    if (!gate.ok) return reply.code(gate.status).send({ error: gate.error });
    try {
      const node = nodeManager.enableNode(nodeId);
      return { node };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /不存在/.test(msg) ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.get('/api/users/:channel/:userId/preferences', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const { channel, userId } = request.params as { channel: string; userId: string };
    const pref = prefs.get(channel, userId);
    return {
      defaultNodeId: pref?.defaultNodeId ?? null,
      defaultAgentId: pref?.defaultAgentId ?? null,
    };
  });

  app.put('/api/users/:channel/:userId/preferences', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const { channel, userId } = request.params as { channel: string; userId: string };
    const body = request.body as { nodeId?: string; agentId?: string } | null | undefined;
    const nodeId = body?.nodeId?.trim() || LOCAL_NODE_ID;
    const agentId = body?.agentId?.trim().toLowerCase();
    if (!agentId) return reply.code(400).send({ error: 'agentId 必填' });
    if (!manager.hasRoutingAgent(nodeId, agentId)) {
      return reply.code(400).send({ error: `节点 ${nodeId} 上没有可用 agent: ${agentId}（请确认节点在线且已提供该 agent）` });
    }
    const pref = {
      channel,
      userId,
      defaultNodeId: nodeId,
      defaultAgentId: agentId,
      updatedAt: Date.now(),
    };
    prefs.put(pref);
    return { defaultNodeId: nodeId, defaultAgentId: agentId };
  });
}
