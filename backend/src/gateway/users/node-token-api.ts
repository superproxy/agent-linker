import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodeTokenPublic } from '@linkagent/shared';
import type { AuthGuard } from './auth.js';
import type { NodeTokenRecord, NodeTokenStore } from './node-token-store.js';

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

/**
 * 用户颁发的机器 token（每台远程节点一枚）：
 *   GET    /api/node-tokens           自己的列表（含全文，可重复查看）
 *   POST   /api/node-tokens           颁发 { label? }，当次回全文
 *   POST   /api/node-tokens/:id/rotate 轮换（新全文、解除 nodeId 锁定）
 *   DELETE /api/node-tokens/:id       吊销
 */
export function registerNodeTokenApi(app: FastifyInstance, tokens: NodeTokenStore, guard: AuthGuard): void {
  const requireSelf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const s = guard.resolve(request as HeaderCarrier);
    if (s.status === 'session' || s.status === 'personal' || s.status === 'local') return s.user.username;
    void reply.code(401).send({ error: '请先登录后再颁发机器凭证' });
    return null;
  };

  const publicOf = (r: NodeTokenRecord): NodeTokenPublic => ({
    id: r.id,
    token: r.token,
    tokenPreview: `${r.token.slice(0, 6)}…`,
    ...(r.label ? { label: r.label } : {}),
    ...(r.nodeId ? { nodeId: r.nodeId } : {}),
    createdAt: r.createdAt,
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
  });

  app.get('/api/node-tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    return { tokens: tokens.listForUser(username).map(publicOf) };
  });

  app.post('/api/node-tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const body = (request.body ?? {}) as { label?: unknown };
    const label = typeof body.label === 'string' ? body.label : '';
    const rec = tokens.issue(username, label);
    request.log.info({ user: username, id: rec.id }, '颁发机器 token');
    return publicOf(rec);
  });

  app.post('/api/node-tokens/:id/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const { id } = request.params as { id: string };
    const rec = tokens.rotate(username, id);
    if (!rec) return reply.code(404).send({ error: '机器凭证不存在' });
    request.log.info({ user: username, id }, '轮换机器 token');
    return publicOf(rec);
  });

  app.delete('/api/node-tokens/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const { id } = request.params as { id: string };
    if (!tokens.revoke(username, id)) return reply.code(404).send({ error: '机器凭证不存在' });
    request.log.info({ user: username, id }, '吊销机器 token');
    return { ok: true };
  });
}
