import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PersonalTokenPublic } from '@linkagent/shared';
import type { AuthGuard } from './auth.js';
import type { PersonalTokenRecord, PersonalTokenStore } from './personal-token-store.js';

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

/**
 * 登录账号「个人 API token」自助管理（与管理员的渠道用户凭据 /api/channel-tokens 同构，
 * 区别：这里任何登录账号只能操作自己的那一枚，非 admin 专属）。
 *   GET    /api/personal-tokens          查看自己的 token（含全文，可重复查看）
 *   POST   /api/personal-tokens/ensure   获取或签发自己的 token（幂等）
 *   POST   /api/personal-tokens/rotate   轮换（签发新 token 并吊销旧 token）
 *   DELETE /api/personal-tokens          吊销自己的 token
 *
 * 用途：OpenAI 兼容客户端（Chatbox 等）以 Authorization: Bearer pat_... 直连网关 /v1，
 * 权限等同账号本人。静态 gateway token / 本机默认用户 / open 模式无账号实体，不涉及。
 */
export function registerPersonalTokenApi(
  app: FastifyInstance,
  tokens: PersonalTokenStore,
  guard: AuthGuard,
): void {
  /** 当前请求对应的登录账号：仅 session / personal 两类凭据有账号实体 */
  const requireSelf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const s = guard.resolve(request as HeaderCarrier);
    if (s.status !== 'session' && s.status !== 'personal') {
      void reply.code(401).send({ error: '请先用账号密码登录后管理个人 API token' });
      return null;
    }
    return s.user.username;
  };

  const publicOf = (r: PersonalTokenRecord): PersonalTokenPublic => ({
    token: r.token,
    tokenPreview: `${r.token.slice(0, 6)}…`,
    createdAt: r.createdAt,
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
  });

  app.get('/api/personal-tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const rec = tokens.find(username);
    return { token: rec ? publicOf(rec) : null };
  });

  app.post('/api/personal-tokens/ensure', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    const rec = tokens.ensure(username);
    request.log.info({ user: username }, '获取个人 API token');
    return { token: rec.token };
  });

  app.post('/api/personal-tokens/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    tokens.revokeForUser(username); // 轮换：先吊销旧 token
    const rec = tokens.issue(username);
    request.log.info({ user: username }, '轮换个人 API token');
    return { token: rec.token };
  });

  app.delete('/api/personal-tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const username = requireSelf(request, reply);
    if (!username) return reply;
    tokens.revokeForUser(username);
    request.log.info({ user: username }, '吊销个人 API token');
    return { ok: true };
  });
}
