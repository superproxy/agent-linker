import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_ADMIN_USERNAME,
  USERNAME_PATTERN,
  USER_ROLES,
  toUserPublic,
  type CreateUserRequest,
  type ResetPasswordRequest,
  type UserRole,
} from '@linkagent/shared';
import { validatePassword } from './password.js';
import { AuthError, type UserStore } from './store.js';
import { isLoopbackIp, type AuthGuard } from './auth.js';
import type { PersonalTokenStore } from './personal-token-store.js';
import type { NodeTokenStore } from './node-token-store.js';

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

function errBody(message: string, code: string) {
  return { error: { message, type: 'invalid_request_error', code, param: null } };
}

/** 极简登录失败限流：同用户名连续失败 N 次后锁定一段时间（进程内内存，重启清零） */
class LoginThrottle {
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>();
  constructor(
    private readonly maxFails = 5,
    private readonly lockMs = 5 * 60 * 1000,
  ) {}

  /** 返回非空字符串表示当前被锁定的提示 */
  locked(username: string): string | null {
    const e = this.fails.get(username);
    if (e && e.lockedUntil > Date.now()) {
      const mins = Math.ceil((e.lockedUntil - Date.now()) / 60000);
      return `失败次数过多，请 ${mins} 分钟后再试`;
    }
    return null;
  }

  fail(username: string): void {
    const e = this.fails.get(username) ?? { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFails) {
      e.lockedUntil = Date.now() + this.lockMs;
      e.count = 0;
    }
    this.fails.set(username, e);
  }

  reset(username: string): void {
    this.fails.delete(username);
  }
}

/**
 * 登录 / 会话 / 改密接口：
 *   POST /api/auth/login           账号密码登录 → 会话 token（无需鉴权）
 *   POST /api/auth/logout          注销当前会话
 *   GET  /api/auth/me              当前鉴权态（前端启动判断登录）
 *   POST /api/auth/change-password 修改自己的密码（改完解除 mustChangePassword）
 */
export function registerAuthApi(app: FastifyInstance, store: UserStore, guard: AuthGuard): void {
  const throttle = new LoginThrottle();

  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    // open 模式不鉴权，登录无意义；local 模式回环免登录，账号登录仅用于非回环/多用户场景
    if (!guard.enabled) {
      return reply.code(400).send(errBody('网关未开启鉴权（auth.mode=open），无需登录', 'auth_disabled'));
    }
    const body = request.body as { username?: unknown; password?: unknown } | null | undefined;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return reply.code(400).send(errBody('用户名和密码不能为空', 'missing_credentials'));
    }
    const lockMsg = throttle.locked(username);
    if (lockMsg) return reply.code(429).send(errBody(lockMsg, 'login_locked'));

    let user;
    try {
      user = store.authenticate(username, password);
    } catch (e) {
      if (e instanceof AuthError) {
        throttle.fail(username);
        return reply.code(401).send(errBody(e.message, 'invalid_credentials'));
      }
      throw e;
    }
    throttle.reset(username);
    const session = store.createSession(user.username, guard.sessionTtlMs);
    request.log.info({ user: user.username }, '用户登录');
    return reply.send({ token: session.token, user: toUserPublic(user) });
  });

  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const h = request.headers.authorization;
    const value = Array.isArray(h) ? (h[0] ?? '') : (h ?? '');
    const token = value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
    if (token) store.revokeSession(token);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const state = guard.resolve(request as HeaderCarrier);
    if (state.status === 'none') {
      // token 模式、或 local 模式非回环：第一次需要登录时才生成 admin 随机密码
      const initialAdmin = bootstrapInitialAdmin(request, store, guard);
      return reply.code(401).send({
        ...errBody('未登录或凭据已失效', 'unauthorized'),
        ...(initialAdmin ? { initialAdmin } : {}),
      });
    }
    if (state.status === 'session' || state.status === 'personal') {
      // 会话 / 个人 API token 都对应一个登录账号，返回该账号本人
      return reply.send({ authEnabled: true, user: toUserPublic(state.user) });
    }
    if (state.status === 'local') {
      // 本机默认用户（回环免登录 / gateway token）——不创建、不索要 admin 密码
      return reply.send({ authEnabled: true, user: toUserPublic(state.user), local: true });
    }
    if (state.status === 'token') {
      return reply.send({ authEnabled: true, user: null, tokenAuth: true });
    }
    if (state.status === 'disabled') {
      return reply.send({ authEnabled: false, user: null });
    }
    return reply.send({ authEnabled: true, user: null });
  });

  app.post('/api/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const state = guard.resolve(request as HeaderCarrier);
    if (state.status === 'none') {
      return reply.code(401).send(errBody('未登录或凭据已失效', 'unauthorized'));
    }
    // 仅登录用户可改自己的密码；静态 token / 本机默认用户不对应可改密的账号
    if (state.status !== 'session') {
      return reply.code(403).send(errBody('当前凭据不支持改密，请用账号登录后操作', 'not_session'));
    }
    const body = request.body as { oldPassword?: unknown; newPassword?: unknown } | null | undefined;
    const oldPassword = typeof body?.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    const pwError = validatePassword(newPassword);
    if (pwError) return reply.code(400).send(errBody(pwError, 'weak_password'));
    if (newPassword === oldPassword) {
      return reply.code(400).send(errBody('新密码不能与旧密码相同', 'same_password'));
    }
    try {
      store.authenticate(state.user.username, oldPassword);
    } catch (e) {
      if (e instanceof AuthError) {
        return reply.code(401).send(errBody('原密码不正确', 'invalid_credentials'));
      }
      throw e;
    }
    store.setPassword(state.user.username, newPassword, false);
    request.log.info({ user: state.user.username }, '用户修改密码');
    return reply.send({ ok: true });
  });
}

/**
 * 登录账号管理接口（仅 admin；未开启鉴权 / 静态 token 视为管理员）。
 * 路径用 /api/admin/users 与任务系统的「渠道终端用户」/api/users 区分：
 *   GET    /api/admin/users                       登录账号列表
 *   POST   /api/admin/users                       新建账号
 *   DELETE /api/admin/users/:username             删除账号（禁止删自己 / 最后一个 admin）
 *   POST   /api/admin/users/:username/reset-password  管理员重置密码
 */
export function registerUserApi(
  app: FastifyInstance,
  store: UserStore,
  guard: AuthGuard,
  personalTokens?: PersonalTokenStore,
  nodeTokens?: NodeTokenStore,
): void {
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!guard.isAdmin(request as HeaderCarrier)) {
      void reply.code(403).send(errBody('需要管理员权限', 'forbidden'));
      return false;
    }
    return true;
  };

  app.get('/api/admin/users', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const users = store
      .list()
      .map(toUserPublic)
      .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1));
    return reply.send({ users });
  });

  app.post('/api/admin/users', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const body = (request.body ?? {}) as Partial<CreateUserRequest>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!USERNAME_PATTERN.test(username)) {
      return reply.code(400).send(errBody('用户名仅支持字母数字 . _ -，长度 1~32', 'invalid_username'));
    }
    const pwError = validatePassword(typeof body.password === 'string' ? body.password : '');
    if (pwError) return reply.code(400).send(errBody(pwError, 'weak_password'));
    const role: UserRole = body.role && USER_ROLES.includes(body.role) ? body.role : 'user';
    try {
      const user = store.create({
        username,
        password: body.password as string,
        role,
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        // 管理员新建的用户首次登录强制改密
        mustChangePassword: true,
      });
      request.log.info({ user: username, by: guard.sessionUser(request as HeaderCarrier)?.username ?? 'token' }, '新建用户');
      return reply.send({ user: toUserPublic(user) });
    } catch (e) {
      return reply.code(409).send(errBody(e instanceof Error ? e.message : String(e), 'user_exists'));
    }
  });

  app.delete('/api/admin/users/:username', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { username } = request.params as { username: string };
    const current = guard.sessionUser(request as HeaderCarrier);
    if (current && current.username === username) {
      return reply.code(400).send(errBody('不能删除当前登录账号', 'cannot_delete_self'));
    }
    const target = store.get(username);
    if (!target) return reply.code(404).send(errBody(`用户不存在: ${username}`, 'user_not_found'));
    if (target.role === 'admin') {
      const adminCount = store.list().filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) {
        return reply.code(400).send(errBody('至少保留一个管理员账号', 'last_admin'));
      }
    }
    store.delete(username);
    personalTokens?.revokeForUser(username);
    nodeTokens?.revokeForUser(username);
    request.log.info({ user: username, by: current?.username ?? 'token' }, '删除用户');
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:username/reset-password', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { username } = request.params as { username: string };
    const body = (request.body ?? {}) as Partial<ResetPasswordRequest>;
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const pwError = validatePassword(newPassword);
    if (pwError) return reply.code(400).send(errBody(pwError, 'weak_password'));
    if (!store.get(username)) return reply.code(404).send(errBody(`用户不存在: ${username}`, 'user_not_found'));
    // 默认重置后要求该用户首次登录改密
    const mustChange = body.mustChangePassword !== false;
    store.setPassword(username, newPassword, mustChange);
    request.log.info({ user: username, by: guard.sessionUser(request as HeaderCarrier)?.username ?? 'token' }, '管理员重置密码');
    return reply.send({ ok: true, mustChangePassword: mustChange });
  });
}

/** 账号库为空且当前请求需要登录时生成 admin；明文仅回环返回 */
function bootstrapInitialAdmin(
  request: FastifyRequest,
  store: UserStore,
  guard: AuthGuard,
): { username: string; password: string } | undefined {
  if (!guard.enabled) return undefined;
  const r = store.ensureDefaultAdmin();
  if (r.created && r.password) {
    request.log.warn(
      `已生成初始管理员 ${DEFAULT_ADMIN_USERNAME}，密码：${r.password}（仅本机回环登录页展示，请立即改密）`,
    );
  }
  const password = r.password;
  if (!password || !isLoopbackIp(request.ip)) return undefined;
  return { username: DEFAULT_ADMIN_USERNAME, password };
}
