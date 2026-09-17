import type { UserRecord } from '@linkagent/shared';
import type { UserStore } from './store.js';
import type { ChannelTokenRecord, ChannelTokenStore } from './channel-token-store.js';

/**
 * 鉴权态解析结果：
 * - disabled：网关未开启鉴权（auth.enabled=false，本地开发）
 * - token：静态 token（auth.token，机器客户端 / 节点连接器，管理员级）
 * - session：登录会话（Web UI 用户，携带用户实体与角色）
 * - task：任务级直连凭据（任务 key），仅可访问 /v1 且锁定到该任务
 * - channelUser：渠道终端用户凭据（ct_），仅可访问 /v1 自己的任务路由与自己的 GET /api/tasks
 * - none：未携带凭据或凭据无效
 */
export type AuthState =
  | { status: 'disabled' }
  | { status: 'token' }
  | { status: 'session'; user: UserRecord }
  | { status: 'task'; channel: string; userId: string; taskId: string; taskKey: string }
  | { status: 'channelUser'; channel: string; userId: string }
  | { status: 'none' };

type HeaderCarrier = { headers: Record<string, string | string[] | undefined> };

/** 任务 key 反查依赖（避免 users 层反向依赖 tasks 层，由网关入口注入） */
export interface TaskKeyResolver {
  findByKey(key: string): { channel: string; userId: string; task: { id: string; key?: string; keyEnabled?: boolean } } | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 统一鉴权守卫：静态 token 与登录会话并存，另支持两类作用域受限凭据
 * （任务 key 直连 / 渠道终端用户 token）。
 * checkAuth 兼容既有 (req)=>boolean 签名（tasks/nodes/weixin API 注册处零改动）。
 */
export class AuthGuard {
  readonly sessionTtlMs: number;

  constructor(
    private readonly store: UserStore,
    private readonly opts: {
      enabled: boolean;
      staticToken: string;
      sessionTtlDays: number;
      /** 任务 key 反查（提供后 /v1 支持任务级直连凭据） */
      taskKeys?: TaskKeyResolver;
      /** 渠道终端用户 token 存储（提供后 /v1 支持用户级凭据） */
      channelTokens?: ChannelTokenStore;
    },
  ) {
    this.sessionTtlMs = opts.sessionTtlDays * DAY_MS;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private static bearer(req: HeaderCarrier): string {
    const h = req.headers.authorization;
    const value = Array.isArray(h) ? (h[0] ?? '') : (h ?? '');
    return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
  }

  /** 常规凭据解析（静态 token / 会话 / 渠道用户 token）；任务 key 仅在 resolveChat 中识别 */
  resolve(req: HeaderCarrier): AuthState {
    if (!this.opts.enabled) return { status: 'disabled' };
    const token = AuthGuard.bearer(req);
    if (!token) return { status: 'none' };
    if (this.opts.staticToken !== '' && token === this.opts.staticToken) return { status: 'token' };

    const session = this.store.resolveSession(token, this.sessionTtlMs);
    if (session) {
      const user = this.store.get(session.username);
      if (user) return { status: 'session', user };
    }

    // 渠道终端用户凭据：仅标记作用域，能否访问具体接口由各入口按作用域二次校验
    const channelRec = this.opts.channelTokens?.resolve(token);
    if (channelRec) {
      this.opts.channelTokens?.touch(token);
      return { status: 'channelUser', channel: channelRec.channel, userId: channelRec.userId };
    }

    return { status: 'none' };
  }

  /**
   * /v1/chat/completions 专用鉴权：在常规凭据之外，额外接受两类作用域凭据：
   *   1. Authorization: Bearer <任务 key>      —— 任务级直连（Chatbox 可直接把 key 当 API key）
   *   2. body.taskKey（无有效常规凭据时）       —— 兼容旧调用方，任务 key 同时充当凭据
   * 解析出的任务会被「锁定」（返回 state.task），handler 必须强制路由到该任务、忽略越权字段。
   */
  resolveChat(req: HeaderCarrier, body?: { taskKey?: unknown }): AuthState {
    if (!this.opts.enabled) return { status: 'disabled' };

    const bearer = AuthGuard.bearer(req);

    // 1) Bearer 本身是任务 key → 任务级直连
    if (bearer && this.opts.taskKeys) {
      const ref = this.opts.taskKeys.findByKey(bearer);
      if (ref) {
        if (ref.task.keyEnabled === false) return { status: 'none' }; // 停用 key 等同无效凭据
        return {
          status: 'task',
          channel: ref.channel,
          userId: ref.userId,
          taskId: ref.task.id,
          taskKey: ref.task.key ?? bearer,
        };
      }
    }

    // 2) 常规凭据（静态 token / 会话 / 渠道用户 token）
    const regular = this.resolve(req);
    if (regular.status !== 'none') return regular;

    // 3) 无有效常规凭据，但 body 带任务 key → 任务 key 充当凭据直连
    const bodyKey = typeof body?.taskKey === 'string' ? body.taskKey.trim() : '';
    if (bodyKey && this.opts.taskKeys) {
      const ref = this.opts.taskKeys.findByKey(bodyKey);
      if (ref) {
        if (ref.task.keyEnabled === false) return { status: 'none' };
        return {
          status: 'task',
          channel: ref.channel,
          userId: ref.userId,
          taskId: ref.task.id,
          taskKey: ref.task.key ?? bodyKey,
        };
      }
    }

    return { status: 'none' };
  }

  /** 已通过鉴权（静态 token / 有效会话 / 未开启鉴权）；作用域凭据不在此放行 */
  checkAuth(req: HeaderCarrier): boolean {
    const s = this.resolve(req).status;
    return s === 'disabled' || s === 'token' || s === 'session';
  }

  /** 当前会话对应的登录用户（静态 token / 未开启鉴权时为 null） */
  sessionUser(req: HeaderCarrier): UserRecord | null {
    const state = this.resolve(req);
    return state.status === 'session' ? state.user : null;
  }

  /** 管理员操作：未开启鉴权 / 静态 token 视为管理员；会话需 role=admin */
  isAdmin(req: HeaderCarrier): boolean {
    const state = this.resolve(req);
    if (state.status === 'disabled' || state.status === 'token') return true;
    return state.status === 'session' && state.user.role === 'admin';
  }
}
