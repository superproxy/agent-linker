/**
 * 本机进程管理 REST（仅回环 + 管理员可用）：
 *   GET  /api/system/info        网关只读信息 + 是否本机访问（前端据此决定是否展示进程卡片）
 *   GET  /api/pm/status          gateway / weixin / node 运行态
 *   POST /api/pm/start           { targets: ['weixin'|'node'] }（不允许经 web 拉起 gateway）
 *   POST /api/pm/stop            { targets: ['weixin'|'node'] }（不允许经 web 停止 gateway）
 *   POST /api/pm/restart         { targets: string[] }（gateway 仅允许 restart，走接力自重启）
 *   GET  /api/pm/logs/:id?tail=  某进程日志尾部文本
 *
 * 安全：进程能操控本机，必须同时满足
 *   1) 管理员（authGuard.isAdmin：未开鉴权 / 静态 token / admin 会话）
 *   2) 回环来源（127.0.0.1 / ::1 / ::ffff:127.0.0.1）
 * 连到远程网关时这些接口一律 403，前端也会据 /api/system/info.local 隐藏入口。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProcessManager, type TargetId } from '../../supervisor/manager.js';
import type { AuthGuard } from '../users/auth.js';

/** 回环来源判定（未开启 trustProxy，反向代理来源不会被当成本机） */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 白名单校验 targets；gateway 不允许 start/stop（只能 restart） */
export function normalizeTargets(input: unknown, opts: { allowGateway?: boolean } = {}): TargetId[] {
  const raw = Array.isArray(input) ? input : [input];
  const out: TargetId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('targets 必须是字符串数组');
    const id = item.trim();
    if (id !== 'gateway' && id !== 'weixin' && id !== 'node') {
      throw new Error(`未知进程 "${id}"，可选：gateway | weixin | node`);
    }
    if (id === 'gateway' && !opts.allowGateway) {
      throw new Error('网关进程不允许经网页启动/停止（仅可重启），请在本机用 CLI 操作');
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error('targets 不能为空');
  return out;
}

export interface PmApiDeps {
  pm: ProcessManager;
  authGuard: AuthGuard;
  server: { host: string; port: number; authEnabled: boolean; authMode?: string; sessionTtlDays: number };
}

export function registerPmApi(app: FastifyInstance, deps: PmApiDeps): void {
  const { pm, authGuard, server } = deps;

  /** 管理员 + 回环双校验；不满足时已写好响应，返回 false */
  const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!authGuard.isAdmin(request)) {
      void reply.code(403).send({ error: '仅管理员可操作进程管理' });
      return false;
    }
    if (!isLoopbackIp(request.ip)) {
      void reply.code(403).send({ error: '进程管理仅限本机回环访问' });
      return false;
    }
    return true;
  };

  app.get('/api/system/info', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    return {
      host: server.host,
      port: server.port,
      authEnabled: server.authEnabled,
      authMode: server.authMode ?? (server.authEnabled ? 'token' : 'open'),
      sessionTtlDays: server.sessionTtlDays,
      local: isLoopbackIp(request.ip),
    };
  });

  app.get('/api/pm/status', async (request, reply) => {
    if (!guard(request, reply)) return;
    return { processes: pm.status() };
  });

  app.post('/api/pm/start', async (request, reply) => {
    if (!guard(request, reply)) return;
    try {
      const targets = normalizeTargets((request.body as { targets?: unknown } | null)?.targets);
      await pm.start(targets);
      return { ok: true, processes: pm.status() };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pm/stop', async (request, reply) => {
    if (!guard(request, reply)) return;
    try {
      const targets = normalizeTargets((request.body as { targets?: unknown } | null)?.targets);
      await pm.stop(targets);
      return { ok: true, processes: pm.status() };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pm/restart', async (request, reply) => {
    if (!guard(request, reply)) return;
    let targets: TargetId[];
    try {
      targets = normalizeTargets((request.body as { targets?: unknown } | null)?.targets, { allowGateway: true });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    // gateway 自重启：先重启其余目标，再起接力进程，最后优雅退出当前网关
    if (targets.includes('gateway')) {
      const others = targets.filter((id) => id !== 'gateway');
      if (others.length > 0) await pm.restart(others);
      pm.relaunchGateway();
      // 响应已交给 fastify 序列化；延迟发 SIGTERM 触发既有 shutdown 流程
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 400).unref();
      return { ok: true, restarting: true, gateway: true };
    }

    await pm.restart(targets);
    return { ok: true, processes: pm.status() };
  });

  app.get('/api/pm/logs/:id', async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id } = request.params as { id: string };
    if (id !== 'gateway' && id !== 'weixin' && id !== 'node') {
      return reply.code(400).send({ error: `未知进程 "${id}"` });
    }
    const q = request.query as { tail?: string };
    const tail = Math.min(2000, Math.max(1, Number(q.tail) || 200));
    return { id, tail, content: pm.readTailLog(id, tail) };
  });
}
