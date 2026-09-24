/**
 * 进程管理 REST（管理员可用，操作的是当前这台网关进程）：
 *   GET  /api/system/info        网关只读信息 + 是否本机回环访问
 *   GET  /api/pm/status          gateway / weixin（含 weixin:<id> 多账号实例）/ node 运行态
 *   POST /api/pm/start           { targets: ['weixin'|'weixin:<id>'|'node'] }（不允许经 web 拉起 gateway）
 *   POST /api/pm/stop            { targets: ['weixin'|'weixin:<id>'|'node'] }（不允许经 web 停止 gateway）
 *   POST /api/pm/restart         { targets: string[] }（gateway 仅允许 restart，走接力自重启）
 *   GET  /api/pm/logs/:id?tail=  某进程日志尾部文本（id 可为 weixin:<accountId>）
 *   GET  /api/pm/gateway-targets           weixin/node 当前挂载网关（token 只回是否已配置）
 *   PUT  /api/pm/gateway-targets/:id       { url, token? } 落盘后自动重启该进程（url 空串=切回本机）
 *
 * 安全：仅管理员（authGuard.isAdmin：open / 静态 token / local 默认用户 / admin 会话）。
 * web 与网关同端口，打开哪台机器的后台（/）就管哪台机器上的进程。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadSharedConfig, persistChildGatewayTarget } from '../config.js';
import {
  ProcessManager,
  instOf,
  isKnownTargetId,
  type ProcessInstanceId,
} from '../../supervisor/manager.js';
import type { ChildSectionId, ChildGatewayTarget } from '../config.js';
import type { AuthGuard } from '../users/auth.js';

/** 回环来源判定（未开启 trustProxy，反向代理来源不会被当成本机） */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 白名单校验 targets；gateway 不允许 start/stop（只能 restart）；weixin 支持 weixin:<accountId> 实例 */
export function normalizeTargets(input: unknown, opts: { allowGateway?: boolean } = {}): ProcessInstanceId[] {
  const raw = Array.isArray(input) ? input : [input];
  const out: ProcessInstanceId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('targets 必须是字符串数组');
    const id = item.trim();
    if (!isKnownTargetId(id)) {
      throw new Error(`未知进程 "${id}"，可选：gateway | weixin | node | weixin:<accountId>`);
    }
    if (instOf(id).base === 'gateway' && !opts.allowGateway) {
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
  configPath: string;
  runtimeGatewayDir: string;
  /** 落盘成功后同步网关内存配置；不落内存不影响重启后的子进程，仅为保持本进程读到的一致 */
  onChildGatewayChanged?: (section: ChildSectionId, target: ChildGatewayTarget) => void;
  server: { host: string; port: number; authEnabled: boolean; authMode?: string; sessionTtlDays: number };
}

export function registerPmApi(app: FastifyInstance, deps: PmApiDeps): void {
  const { pm, authGuard, server } = deps;

  /** 仅管理员；不满足时已写好响应，返回 false */
  const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!authGuard.isAdmin(request)) {
      void reply.code(403).send({ error: '仅管理员可操作进程管理' });
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
    let targets: ProcessInstanceId[];
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
    if (!isKnownTargetId(id)) {
      return reply.code(400).send({ error: `未知进程 "${id}"` });
    }
    const q = request.query as { tail?: string };
    const tail = Math.min(2000, Math.max(1, Number(q.tail) || 200));
    return { id, tail, content: pm.readTailLog(id, tail) };
  });

  /** 读取 weixin/node 挂载网关：url 缺省即本机网关；token 只回是否已配置，不回明文 */
  const readTargets = (): Record<ChildSectionId, { url: string; local: boolean; tokenConfigured: boolean }> => {
    const cfg = loadSharedConfig(deps.configPath, deps.runtimeGatewayDir).config;
    const out = {} as Record<ChildSectionId, { url: string; local: boolean; tokenConfigured: boolean }>;
    for (const section of ['weixin', 'node'] as ChildSectionId[]) {
      const url = cfg[section].gatewayUrl?.replace(/\/+$/, '') ?? '';
      out[section] = { url, local: !url, tokenConfigured: !!cfg[section].gatewayToken };
    }
    return out;
  };

  app.get('/api/pm/gateway-targets', async (request, reply) => {
    if (!guard(request, reply)) return;
    return { targets: readTargets() };
  });

  app.put('/api/pm/gateway-targets/:id', async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id } = request.params as { id: string };
    if (id !== 'weixin' && id !== 'node') {
      return reply.code(400).send({ error: `未知进程 "${id}"，可选：weixin | node` });
    }
    const body = (request.body ?? {}) as { url?: unknown; token?: unknown };
    if (typeof body.url !== 'string' || (body.token !== undefined && typeof body.token !== 'string')) {
      return reply.code(400).send({ error: 'url 必须为字符串，token 为可选字符串' });
    }
    const target: ChildGatewayTarget = { url: body.url, token: body.token ?? '' };
    try {
      persistChildGatewayTarget(deps.configPath, id, target, deps.runtimeGatewayDir);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    deps.onChildGatewayChanged?.(id, { url: target.url.trim().replace(/\/+$/, ''), token: target.token.trim() });

    // 保存并重启：仅重启该子进程（未在运行则直接拉起）
    await pm.restart([id]);
    return { ok: true, targets: readTargets(), processes: pm.status() };
  });
}
