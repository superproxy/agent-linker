import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthGuard } from './auth.js';
import type { ChannelTokenStore } from './channel-token-store.js';
import type { TaskService } from '../tasks/service.js';

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

/**
 * 渠道终端用户凭据管理。
 *
 * 管理接口（仅管理员 / 静态 token）：
 *   GET    /api/channel-tokens                 列出全部用户级 token
 *   POST   /api/channel-tokens/ensure          获取或签发某渠道用户 token（幂等）
 *   POST   /api/channel-tokens/rotate          轮换（签发新 token 并吊销旧 token）
 *   DELETE /api/channel-tokens/:token          吊销指定 token
 *
 * bot 引导（external 独立进程模式，持静态 token 换取用户级 token）：
 *   POST   /api/bot/channel-token { channel, userId }  → { token }
 *   仅静态 token / 管理员可用；微信 bot 进程首次为某用户处理消息时换取并本地缓存。
 */
export function registerChannelTokenApi(
  app: FastifyInstance,
  tokens: ChannelTokenStore,
  guard: AuthGuard,
  taskService: TaskService,
  deps: { listAvailableAgents?: () => string[] } = {},
): void {
  void deps; // 预留：后续按 agent 作用域收窄时使用
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!guard.isAdmin(request as HeaderCarrier)) {
      void reply.code(403).send({ error: '需要管理员权限' });
      return false;
    }
    return true;
  };

  const publicOf = (r: ReturnType<ChannelTokenStore['list']>[number]) => ({
    // token 本体仅在 ensure/rotate/引导接口返回；列表不回显完整 token，避免后台页面泄露
    channel: r.channel,
    userId: r.userId,
    ...(r.label ? { label: r.label } : {}),
    ...(r.ownerUsername ? { ownerUsername: r.ownerUsername } : {}),
    createdAt: r.createdAt,
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
    tokenPreview: `${r.token.slice(0, 6)}…`,
  });

  app.get('/api/channel-tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    return { tokens: tokens.list().map(publicOf) };
  });

  app.post('/api/channel-tokens/ensure', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const body = request.body as { channel?: string; userId?: string; label?: string; ownerUsername?: string } | null | undefined;
    const channel = body?.channel?.trim();
    const userId = body?.userId?.trim();
    if (!channel || !userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    const rec = tokens.ensure(channel, userId, body?.label, body?.ownerUsername?.trim());
    // 确保该渠道用户已有任务建档（开箱可聊），与 bot 首条消息行为一致
    taskService.load(channel, userId);
    return { token: rec.token, channel: rec.channel, userId: rec.userId };
  });

  app.post('/api/channel-tokens/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const body = request.body as { channel?: string; userId?: string; label?: string; ownerUsername?: string } | null | undefined;
    const channel = body?.channel?.trim();
    const userId = body?.userId?.trim();
    if (!channel || !userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    const owner = body?.ownerUsername?.trim();
    const prev = tokens.find(channel, userId, owner);
    tokens.revokeForUser(channel, userId, owner);
    const rec = tokens.issue(channel, userId, body?.label ?? prev?.label, owner ?? prev?.ownerUsername);
    taskService.load(channel, userId);
    return { token: rec.token, channel: rec.channel, userId: rec.userId };
  });

  app.delete('/api/channel-tokens/:token', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { token } = request.params as { token: string };
    tokens.revoke(decodeURIComponent(token));
    return { ok: true };
  });

  /** 按渠道用户吊销其全部 token（管理列表只回显预览、拿不到完整 token，故按用户吊销） */
  app.delete('/api/channel-tokens/by-user/:channel/:userId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { channel, userId } = request.params as { channel: string; userId: string };
    tokens.revokeForUser(decodeURIComponent(channel), decodeURIComponent(userId));
    return { ok: true };
  });

  /**
   * bot 引导：external 微信进程持静态 token 换取某渠道用户的用户级 token。
   * 静态 token / 管理员可调；换取后 bot 仅持该用户 token，不再长期持有全局静态 token。
   */
  app.post('/api/bot/channel-token', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!guard.enabled) {
      // 未开启鉴权时无用户级凭据概念：bot 直接匿名访问即可
      return reply.code(400).send({ error: '网关未开启鉴权，无需换取用户 token' });
    }
    if (!requireAdmin(request, reply)) return reply;
    const body = request.body as { channel?: string; userId?: string; label?: string; ownerUsername?: string; accountId?: string } | null | undefined;
    const channel = body?.channel?.trim();
    const userId = body?.userId?.trim();
    if (!channel || !userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    const owner = body?.ownerUsername?.trim() || body?.accountId?.trim();
    const rec = tokens.ensure(channel, userId, body?.label, owner);
    taskService.load(channel, userId);
    return { token: rec.token };
  });
}
