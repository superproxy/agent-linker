/**
 * 用户登录体系共享类型（网关 / Web UI 唯一类型源）。
 *
 * 两套凭据并存：
 * - 静态 token（config.yaml auth.token）：给 Chatbox / 节点连接器等机器调用；
 * - 会话 token（登录后签发）：给 Web UI 浏览器调用。
 */

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 登录用户名规则：字母数字 . _ -，1~32 位（同时作为 KV 文件名，天然防路径注入） */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

/** 密码最小长度 */
export const MIN_PASSWORD_LENGTH = 8;

/** 默认管理员账号（账号库为空时，首次需要登录的访问才生成） */
export const DEFAULT_ADMIN_USERNAME = 'admin';

/** 用户落盘记录（.runtime-state/users/accounts/<username>.json，含密码哈希，禁止直接对外返回） */
export interface UserRecord {
  username: string;
  /** scrypt 派生：`scrypt$<saltHex>$<hashHex>` */
  passwordHash: string;
  role: UserRole;
  displayName?: string;
  createdAt: string;
  /** 首次登录 / 管理员重置后要求修改密码 */
  mustChangePassword: boolean;
}

/** 对外暴露的用户信息（不含密码哈希） */
export interface UserPublic {
  username: string;
  role: UserRole;
  displayName?: string;
  createdAt: string;
  mustChangePassword: boolean;
}

/** 会话落盘记录（.runtime-state/users/sessions/<token>.json） */
export interface SessionRecord {
  token: string;
  username: string;
  createdAt: string;
  expiresAt: string;
}

export function toUserPublic(user: UserRecord): UserPublic {
  return {
    username: user.username,
    role: user.role,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    createdAt: user.createdAt,
    mustChangePassword: user.mustChangePassword,
  };
}

// ── HTTP 请求 / 响应载荷 ──

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: UserPublic;
}

/** GET /api/auth/me 响应：authEnabled=false 时网关完全不鉴权（open 模式） */
export interface MeResponse {
  authEnabled: boolean;
  /** 会话 token 有效时返回登录用户 */
  user?: UserPublic | null;
  /** 静态 token 鉴权（机器凭据，无对应用户实体） */
  tokenAuth?: boolean;
  /** local 模式：回环免登录的本机默认用户，或持 gateway token */
  local?: boolean;
  /** 首次需要登录时生成的初始管理员（仅回环 401 响应携带明文，改密后不再返回） */
  initialAdmin?: { username: string; password: string };
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role?: UserRole;
  displayName?: string;
}

export interface ResetPasswordRequest {
  newPassword: string;
  /** 重置后是否要求该用户首次登录改密，默认 true */
  mustChangePassword?: boolean;
}

// ── 个人 API token（登录账号自助管理，pat_ 前缀，用于 OpenAI 客户端直连 /v1）──

/** 个人 token 视图（不含 token 全文，仅预览前缀）；账号尚无 token 时为 null */
export interface PersonalTokenPublic {
  /** token 本体前缀（pat_xxxx…），完整 token 仅在 ensure/rotate 当次返回 */
  tokenPreview: string;
  createdAt: string;
  lastUsedAt?: string;
}

// ── 用户颁发的机器（节点）token（nt_ 前缀，仅用于节点 WebSocket 握手）──

/** 机器 token 列表项（不含全文） */
export interface NodeTokenPublic {
  id: string;
  tokenPreview: string;
  label?: string;
  /** 首次连上后锁定的 nodeId */
  nodeId?: string;
  createdAt: string;
  lastUsedAt?: string;
}
