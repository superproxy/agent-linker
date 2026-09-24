import { DEFAULT_ADMIN_USERNAME, type UserRecord } from '@linkagent/shared';
import type { AuthMode } from '@linkagent/shared';
import type { UserStore } from './store.js';
import type { ChannelTokenRecord, ChannelTokenStore } from './channel-token-store.js';
import type { PersonalTokenStore } from './personal-token-store.js';

/**
 * 鉴权态解析结果：
 * - disabled：open 模式（不鉴权，本地开发）
 * - local：local 模式下的「本机默认用户」（管理员），不区分访问地址；或持 gateway token 的默认用户
 * - token：token 模式下的静态 gateway token（机器客户端 / 节点连接器，管理员级）
 * - session：账号密码登录会话（Web UI 用户，携带用户实体与角色）
 * - personal：登录账号的个人 API token（pat_），等同该账号本人，可直连 /v1，不额外授予管理接口
 * - task：任务级直连凭据（任务 key），仅可访问 /v1 且锁定到该任务
 * - channelUser：渠道终端用户凭据（ct_），仅可访问 /v1 自己的任务路由与自己的 GET /api/tasks
 * - none：未携带凭据或凭据无效
 */
export type AuthState =
  | { status: 'disabled' }
  | { status: 'local'; user: UserRecord }
  | { status: 'token' }
  | { status: 'session'; user: UserRecord }
  | { status: 'personal'; user: UserRecord }
  | { status: 'task'; channel: string; userId: string; taskId: string; taskKey: string; ownerUsername?: string }
  | { status: 'channelUser'; channel: string; userId: string; ownerUsername?: string }
  | { status: 'none' };

type HeaderCarrier = {
  headers: Record<string, string | string[] | undefined>;
  /** Fastify request.ip（local 模式据此判定回环）；非 HTTP 载体可省略 */
  ip?: string;
};

/** 任务 key 反查依赖（避免 users 层反向依赖 tasks 层，由网关入口注入） */
export interface TaskKeyResolver {
  findByKey(key: string): {
    channel: string;
    userId: string;
    ownerUsername?: string;
    task: { id: string; key?: string; keyEnabled?: boolean };
  } | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** local 模式下的「本机默认用户」：无需注册/登录，永久 gateway token 即其凭据 */
export const LOCAL_DEFAULT_USER: UserRecord = {
  username: 'local',
  passwordHash: '',
  role: 'admin',
  displayName: '本机用户',
  mustChangePassword: false,
  createdAt: '',
};

export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * 统一鉴权守卫：gateway token / 登录会话 / local 模式本机用户并存，另支持两类作用域受限凭据
 * （任务 key 直连 / 渠道终端用户 token）。
 * checkAuth 兼容既有 (req)=>boolean 签名（tasks/nodes/weixin API 注册处零改动）。
 */
export class AuthGuard {
  readonly sessionTtlMs: number;

  constructor(
    private readonly store: UserStore,
    private readonly opts: {
      /** 鉴权模式：local（本机默认）/ token（强制令牌）/ open（不鉴权） */
      mode: AuthMode;
      /** 永久 gateway token（local/token 模式生效；open 为空） */
      staticToken: string;
      sessionTtlDays: number;
      /** 任务 key 反查（提供后 /v1 支持任务级直连凭据） */
      taskKeys?: TaskKeyResolver;
      /** 渠道终端用户 token 存储（提供后 /v1 支持用户级凭据） */
      channelTokens?: ChannelTokenStore;
      /** 登录账号个人 API token 存储（提供后支持 pat_ 凭据，等同账号本人） */
      personalTokens?: PersonalTokenStore;
    },
  ) {
    this.sessionTtlMs = opts.sessionTtlDays * DAY_MS;
  }

  /** 是否处于需要凭据的鉴权态（local/token 为 true；open 为 false） */
  get enabled(): boolean {
    return this.opts.mode !== 'open';
  }

  get mode(): AuthMode {
    return this.opts.mode;
  }

  /** 当前生效的永久 gateway token（open 模式为空串） */
  get gatewayToken(): string {
    return this.opts.staticToken;
  }

  private static bearer(req: HeaderCarrier): string {
    const h = req.headers.authorization;
    const value = Array.isArray(h) ? (h[0] ?? '') : (h ?? '');
    return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
  }

  /** 常规凭据解析（gateway token / 会话 / local 回环 / 渠道用户 token）；任务 key 仅在 resolveChat 中识别 */
  resolve(req: HeaderCarrier): AuthState {
    if (this.opts.mode === 'open') return { status: 'disabled' };

    const token = AuthGuard.bearer(req);

    // 永久 gateway token：用户库已有 admin 时即该账号；否则 local 为本机用户，token 模式仍是无账号的机器凭据
    if (token && this.opts.staticToken !== '' && token === this.opts.staticToken) {
      const admin = this.store.get(DEFAULT_ADMIN_USERNAME);
      if (admin) return { status: 'session', user: admin };
      return this.opts.mode === 'local'
        ? { status: 'local', user: LOCAL_DEFAULT_USER }
        : { status: 'token' };
    }

    if (token) {
      const session = this.store.resolveSession(token, this.sessionTtlMs);
      if (session) {
        const user = this.store.get(session.username);
        if (user) return { status: 'session', user };
      }

      // 登录账号的个人 API token：等同该账号本人（账号已删除则凭据失效）
      const personalRec = this.opts.personalTokens?.resolve(token);
      if (personalRec) {
        const user = this.store.get(personalRec.username);
        if (user) {
          this.opts.personalTokens?.touch(token);
          return { status: 'personal', user };
        }
      }

      // 渠道终端用户凭据：仅标记作用域，能否访问具体接口由各入口按作用域二次校验
      const channelRec = this.opts.channelTokens?.resolve(token);
      if (channelRec) {
        this.opts.channelTokens?.touch(token);
        return {
          status: 'channelUser',
          channel: channelRec.channel,
          userId: channelRec.userId,
          ...(channelRec.ownerUsername ? { ownerUsername: channelRec.ownerUsername } : {}),
        };
      }
    }

    // local 模式：按运行模式识别为本机管理员，不区分回环 / 局域网 / 公网访问地址。
    // 无效或过期的浏览器 token 同样回退为本机用户（免登录）。公网暴露请改用 token 模式。
    if (this.opts.mode === 'local') {
      return { status: 'local', user: LOCAL_DEFAULT_USER };
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
    if (this.opts.mode === 'open') return { status: 'disabled' };

    const bearer = AuthGuard.bearer(req);

    // gateway token 命中则优先按常规凭据处理（不把它误判为任务 key）
    const isGatewayToken = bearer !== '' && this.opts.staticToken !== '' && bearer === this.opts.staticToken;

    // 1) Bearer 本身是任务 key → 任务级直连
    if (!isGatewayToken && bearer && this.opts.taskKeys) {
      const ref = this.opts.taskKeys.findByKey(bearer);
      if (ref) {
        if (ref.task.keyEnabled === false) return { status: 'none' }; // 停用 key 等同无效凭据
        return {
          status: 'task',
          channel: ref.channel,
          userId: ref.userId,
          taskId: ref.task.id,
          taskKey: ref.task.key ?? bearer,
          ...(ref.ownerUsername ? { ownerUsername: ref.ownerUsername } : {}),
        };
      }
    }

    // 2) 常规凭据（gateway token / local 回环 / 会话 / 渠道用户 token）
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
          ...(ref.ownerUsername ? { ownerUsername: ref.ownerUsername } : {}),
        };
      }
    }

    return { status: 'none' };
  }

  /** 已通过鉴权（gateway token / 有效会话 / 个人 token / local 默认用户 / open）；作用域凭据不在此放行 */
  checkAuth(req: HeaderCarrier): boolean {
    const s = this.resolve(req).status;
    return s === 'disabled' || s === 'token' || s === 'session' || s === 'personal' || s === 'local';
  }

  /** 当前会话对应的登录用户（local 默认用户 / 会话用户 / 个人 token 用户；纯 token / open 时为 null） */
  sessionUser(req: HeaderCarrier): UserRecord | null {
    const state = this.resolve(req);
    if (state.status === 'session' || state.status === 'personal') return state.user;
    if (state.status === 'local') return state.user;
    return null;
  }

  /** 管理员操作：open / gateway token / local 默认用户视为管理员；会话/个人 token 需 role=admin */
  isAdmin(req: HeaderCarrier): boolean {
    const state = this.resolve(req);
    if (state.status === 'disabled' || state.status === 'token') return true;
    if (state.status === 'local') return state.user.role === 'admin';
    return (state.status === 'session' || state.status === 'personal') && state.user.role === 'admin';
  }
}
