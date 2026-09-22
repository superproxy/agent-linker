import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodeClaimPublic } from '@linkagent/shared';
import type { AuthGuard } from './auth.js';
import type { NodeClaimRecord, NodeClaimStore } from './node-claim-store.js';

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

/**
 * 匿名节点申请时的归属申明码（nu_）：
 *   POST /api/node-claims/ensure  获取或签发（幂等，当次回全文）
 *   POST /api/node-claims/rotate  轮换
 */
export function registerNodeClaimApi(app: FastifyInstance, claims: NodeClaimStore, guard: AuthGuard): void {
  const requireSelf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const s = guard.resolve(request as HeaderCarrier);
    if (s.status !== 'session' && s.status !== 'personal') {
      void reply.code(401).send({ error: '请先用账号密码登录后获取归属申明码' });
      return null;
    }
    return s.user.username;
  };

  const publicOf = (r: NodeClaimRecord): NodeClaimPublic => ({
    tokenPreview: `${r.token.slice(0, 6)}…`,
    createdAt: r.createdAt,
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
  });

  app.get('/api/node-claims', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const rec = claims.find(username);
    return { claim: rec ? publicOf(rec) : null };
  });

  app.post('/api/node-claims/ensure', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const rec = claims.ensure(username);
    request.log.info({ user: username }, '获取节点归属申明码');
    return { claimToken: rec.token, ...publicOf(rec) };
  });

  app.post('/api/node-claims/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const rec = claims.rotate(username);
    if (!rec) return reply.code(500).send({ error: '轮换失败' });
    request.log.info({ user: username }, '轮换节点归属申明码');
    return { claimToken: rec.token, ...publicOf(rec) };
  });
}
