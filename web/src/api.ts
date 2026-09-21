/** 网关客户端：/healthz + /v1/models + /v1/chat/completions (SSE 流式) */

/** 统一错误：携带 HTTP 状态码，便于上层按 401 跳登录 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fastify 5 在 Content-Type: json 且 body 为空时报 FST_ERR_CTP_EMPTY_JSON_BODY */
function jsonFetchInit(token: string, init?: RequestInit): RequestInit {
  const method = String(init?.method ?? 'GET').toUpperCase();
  const writes = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const body = init?.body ?? (writes ? '{}' : undefined);
  return {
    ...init,
    ...(body !== undefined ? { body } : {}),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  };
}

/** 从 fetch Response 解析后端统一错误体 {error:{message}} / {error:string} */
async function errorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof j.error === 'object' && j.error?.message) return j.error.message;
    if (typeof j.error === 'string') return j.error;
  } catch {
    /* 非 JSON */
  }
  return body.slice(0, 200) || `${res.status}`;
}

export interface AgentInfo {
  id: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  object: string;
  description?: string;
}

export interface HealthInfo {
  ok: boolean;
  agents: AgentInfo[];
}

export interface ChatDelta {
  type: 'reasoning' | 'text' | 'done' | 'error';
  text?: string;
}

/** /v1/chat/completions 流式请求的任务路由扩展（与 chat.html 控制台一致） */
export interface ChatStreamOpts {
  signal?: AbortSignal;
  /** 任务 key 直连：有值时不再带 channel/userId/task */
  taskKey?: string;
  channel?: string;
  userId?: string;
  task?: string;
  agent?: string;
  ownerUsername?: string;
}

export class GatewayClient {
  constructor(
    private base: string,
    private getToken?: () => string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.getToken?.();
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
  }

  async health(): Promise<HealthInfo> {
    const res = await fetch(this.url('/healthz'));
    if (!res.ok) throw new Error(`healthz ${res.status}`);
    return (await res.json()) as HealthInfo;
  }

  async models(): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/v1/models'), { headers: this.authHeaders() });
    if (!res.ok) {
      if (res.status === 401) throw new ApiError(401, await errorMessage(res));
      throw new Error(`/v1/models ${res.status}`);
    }
    const data = (await res.json()) as { data: ModelInfo[] };
    return data.data;
  }

  /** 流式对话：逐条产出 reasoning / text / done 增量；可带任务路由字段进入持久会话 */
  async *streamChat(
    model: string,
    messages: { role: string; content: string }[],
    opts?: AbortSignal | ChatStreamOpts,
  ): AsyncGenerator<ChatDelta> {
    const extra: ChatStreamOpts = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
    const body: Record<string, unknown> = { model, messages, stream: true };
    const taskKey = extra.taskKey?.trim();
    if (taskKey) {
      body.taskKey = taskKey;
      if (extra.agent) body.agent = extra.agent;
    } else if (extra.channel && extra.userId) {
      body.channel = extra.channel;
      body.userId = extra.userId;
      if (extra.task) body.task = extra.task;
      if (extra.agent) body.agent = extra.agent;
      if (extra.ownerUsername) body.ownerUsername = extra.ownerUsername;
    }
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: extra.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new ApiError(401, body.slice(0, 200) || '未登录或凭据已失效');
      throw new Error(`chat ${res.status} ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const emit = (raw: string): ChatDelta | null => {
      const line = raw.replace(/^data: /, '').trim();
      if (!line) return null;
      if (line === '[DONE]') return { type: 'done' };
      try {
        const json = JSON.parse(line) as {
          choices?: { delta?: { reasoning_content?: string; content?: string }; finish_reason?: string | null }[];
          error?: { message?: string };
        };
        if (json.error?.message) return { type: 'error', text: json.error.message };
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) return { type: 'reasoning', text: delta.reasoning_content };
        if (delta?.content) return { type: 'text', text: delta.content };
        if (json.choices?.[0]?.finish_reason === 'stop') return { type: 'done' };
        return null;
      } catch {
        return null;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const d = emit(part);
        if (d) yield d;
      }
    }
    if (buf.trim()) {
      const d = emit(buf);
      if (d) yield d;
    }
  }
}

export interface WeixinAccountInfo {
  id: string;
  userId?: string;
  savedAt?: string;
}

export interface WeixinStatus {
  configured: boolean;
  accounts: WeixinAccountInfo[];
  activeAccountId?: string;
  bindAccountId?: string;
  processId?: string;
  processRunning?: boolean;
}

export interface WeixinQrResult {
  sessionKey?: string;
  qrContent: string;
  qrDataUrl?: string;
}

export interface WeixinQrStatus {
  connected: boolean;
  accountId?: string;
  message?: string;
  boundWarning?: string;
}

export class WeixinClient {
  constructor(
    private base: string,
    private getToken?: () => string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.getToken?.();
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
  }

  async status(): Promise<WeixinStatus> {
    const res = await fetch(this.url('/api/weixin/status'), { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`weixin status ${res.status}`);
    return (await res.json()) as WeixinStatus;
  }

  async startQr(accountId?: string): Promise<WeixinQrResult> {
    const res = await fetch(this.url('/api/weixin/qr'), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ force: true, ...(accountId ? { accountId } : {}) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`weixin qr ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as WeixinQrResult;
  }

  async qrStatus(
    sessionKey: string | undefined,
    timeoutMs = 8_000,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<WeixinQrStatus> {
    const q = new URLSearchParams();
    if (sessionKey) q.set('sessionKey', sessionKey);
    q.set('timeoutMs', String(timeoutMs));
    if (accountId) q.set('accountId', accountId);
    const res = await fetch(this.url(`/api/weixin/qr/status?${q}`), { headers: this.authHeaders(), signal });
    const data = (await res.json().catch(() => ({}))) as WeixinQrStatus & { error?: string };
    if (!res.ok) throw new Error(data.error || data.message || `weixin qr status ${res.status}`);
    return data;
  }

  async reload(accountId?: string): Promise<void> {
    const res = await fetch(this.url('/api/weixin/reload'), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(accountId ? { accountId } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`weixin reload ${res.status} ${body.slice(0, 200)}`);
    }
  }

  async unbind(accountId?: string): Promise<void> {
    const res = await fetch(this.url('/api/weixin/unbind'), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(accountId ? { accountId } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`weixin unbind ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

/** 管理后台 agent 运行态（/api/agents） */
export interface AgentDetail {
  id: string;
  type: string;
  displayName: string;
  description: string;
  /** 当前生效的会话模型（undefined=agent 自身默认） */
  model?: string;
  enabled: boolean;
}

/** 远程机器自报开通的 agent（只读） */
export interface RemoteAgentView {
  id: string;
  displayName?: string;
}

/** 远程机器（节点）分组（/api/agents/by-node） */
export interface RemoteNodeAgentView {
  nodeId: string;
  name: string;
  online: boolean;
  status?: 'approved' | 'pending' | 'blocked';
  agents: RemoteAgentView[];
  version?: string;
  connectedAt?: number;
  lastSeenAt?: number;
  remoteAddress?: string;
}

/** 按机器聚合的 agent 开通视图（/api/agents/by-node） */
export interface AgentsByNode {
  defaultAgentId?: string;
  local?: {
    nodeId: 'local';
    name: string;
    online: true;
    status: 'approved';
    agents: AgentDetail[];
  };
  nodes: RemoteNodeAgentView[];
}

/** 管理接口客户端：/api/agents + /api/tasks/default-agent（可带 Bearer token） */
export class AdminClient {
  constructor(
    private base: string,
    private token?: string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(this.url(path), jsonFetchInit(this.token ?? '', init));
    if (!res.ok) {
      const msg = await errorMessage(res);
      // 401/403 抛 ApiError，上层据此跳登录 / 提示权限
      if (res.status === 401 || res.status === 403) throw new ApiError(res.status, msg);
      throw new Error(`${init?.method ?? 'GET'} ${path} ${res.status} ${msg.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }

  /** 全部 agent 运行态详情（含已停用的） */
  async listAgents(): Promise<AgentDetail[]> {
    const data = (await this.request('/api/agents')) as { agents: AgentDetail[] };
    return data.agents;
  }

  /** 按机器（节点）聚合的 agent 开通视图：本机可编辑，远程机器只读 */
  async agentsByNode(): Promise<AgentsByNode> {
    return (await this.request('/api/agents/by-node')) as AgentsByNode;
  }

  /** 运行时热更新 agent（启停 / 切换模型，仅内存生效，重启还原 config.yaml） */
  async patchAgent(id: string, patch: { model?: string | null; enabled?: boolean }): Promise<AgentDetail> {
    const data = (await this.request(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })) as { agent: AgentDetail };
    return data.agent;
  }

  /** 全局默认任务绑定的 agentId（config.yaml tasks.defaultAgentId） */
  async getDefaultAgent(): Promise<string> {
    const data = (await this.request('/api/tasks/default-agent')) as { defaultAgentId: string };
    return data.defaultAgentId;
  }

  /** 设置全局默认 agent，持久化到 config.yaml（重启保留） */
  async setDefaultAgent(agentId: string): Promise<string> {
    const data = (await this.request('/api/tasks/default-agent', {
      method: 'PUT',
      body: JSON.stringify({ agentId }),
    })) as { defaultAgentId: string };
    return data.defaultAgentId;
  }

  /** 支持 ACP 的 Agent 目录（含是否已配置/启用） */
  async catalog(): Promise<AgentCatalogItem[]> {
    const data = (await this.request('/api/agents/catalog')) as { agents: AgentCatalogItem[] };
    return data.agents;
  }

  /** 按目录类型一键添加 agent（热启用，仅内存生效，重启还原 config.yaml） */
  async addAgentByType(type: string): Promise<AgentDetail> {
    const data = (await this.request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ type }),
    })) as { agent: AgentDetail };
    return data.agent;
  }

  /** 按目录白名单在网关本机执行安装（无 argv 时接口会 400，请复制命令到终端） */
  async installAgentCli(type: string): Promise<{
    ok: boolean;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    const data = (await this.request('/api/agents/install', {
      method: 'POST',
      body: JSON.stringify({ type }),
    })) as { ok: boolean; command: string; exitCode: number; stdout: string; stderr: string };
    return data;
  }
}

/** Agent 目录条目（/api/agents/catalog） */
export interface AgentCatalogItem {
  kind: string;
  displayName: string;
  description: string;
  command?: string[];
  installCommand?: string;
  installRunnable?: boolean;
  installHint?: string;
  configured: boolean;
  enabled: boolean;
}

// ── 登录鉴权 / 用户管理 ──

export interface UserPublic {
  username: string;
  role: 'admin' | 'user';
  displayName?: string;
  createdAt: string;
  mustChangePassword: boolean;
}

export interface MeInfo {
  authEnabled: boolean;
  user?: UserPublic | null;
  tokenAuth?: boolean;
  /** local 模式：按运行模式免登录的「本机默认用户」或持 gateway token */
  local?: boolean;
  /** 首次需要登录时生成的初始管理员（仅本机回环返回明文） */
  initialAdmin?: { username: string; password: string };
}

export class AuthClient {
  constructor(private base: string) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  /** 当前鉴权态；未登录返回 user 为空，回环首次访问可能带 initialAdmin */
  async me(token: string): Promise<MeInfo> {
    const res = await fetch(this.url('/api/auth/me'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = (await res.json().catch(() => ({}))) as MeInfo & { error?: { message?: string } };
    if (res.status === 401) {
      return {
        authEnabled: true,
        user: null,
        ...(data.initialAdmin ? { initialAdmin: data.initialAdmin } : {}),
      };
    }
    if (!res.ok) throw new Error(data.error?.message ?? `me ${res.status}`);
    return data;
  }

  async login(username: string, password: string): Promise<{ token: string; user: UserPublic }> {
    const res = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return (await res.json()) as { token: string; user: UserPublic };
  }

  async logout(token: string): Promise<void> {
    await fetch(this.url('/api/auth/logout'), {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {});
  }

  async changePassword(token: string, oldPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(this.url('/api/auth/change-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  }

  // ── 个人 API token（pat_，OpenAI 客户端直连 /v1）──

  /** 查看自己的 token（仅预览；尚无则返回 null） */
  async personalToken(token: string): Promise<PersonalTokenInfo | null> {
    const res = await fetch(this.url('/api/personal-tokens'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    const data = (await res.json()) as { token: PersonalTokenInfo | null };
    return data.token;
  }

  /** 获取或签发自己的 token（幂等），返回完整 token */
  async ensurePersonalToken(token: string): Promise<string> {
    const res = await fetch(this.url('/api/personal-tokens/ensure'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return ((await res.json()) as { token: string }).token;
  }

  /** 轮换：旧 token 立即失效，返回新的完整 token */
  async rotatePersonalToken(token: string): Promise<string> {
    const res = await fetch(this.url('/api/personal-tokens/rotate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return ((await res.json()) as { token: string }).token;
  }

  /** 吊销自己的 token */
  async revokePersonalToken(token: string): Promise<void> {
    const res = await fetch(this.url('/api/personal-tokens'), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  }
}

/** 个人 token 视图（仅预览，不含全文） */
export interface PersonalTokenInfo {
  tokenPreview: string;
  createdAt: string;
  lastUsedAt?: string;
}

export class UserAdminClient {
  constructor(
    private base: string,
    private getToken: () => string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(this.url(path), jsonFetchInit(this.getToken(), init));
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return res.json().catch(() => ({}));
  }

  async list(): Promise<UserPublic[]> {
    const data = (await this.request('/api/admin/users')) as { users: UserPublic[] };
    return data.users;
  }

  async create(input: { username: string; password: string; role?: 'admin' | 'user'; displayName?: string }): Promise<UserPublic> {
    const data = (await this.request('/api/admin/users', { method: 'POST', body: JSON.stringify(input) })) as { user: UserPublic };
    return data.user;
  }

  async remove(username: string): Promise<void> {
    await this.request(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  }

  async resetPassword(username: string, newPassword: string, mustChangePassword = true): Promise<void> {
    await this.request(`/api/admin/users/${encodeURIComponent(username)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword, mustChangePassword }),
    });
  }
}

// ── 网关设置 / 本机进程管理 ──

export interface SystemInfo {
  host: string;
  port: number;
  authEnabled: boolean;
  sessionTtlDays: number;
  /** 当前请求是否来自回环（仅描述网关连接来源，与进程管理菜单无关） */
  local: boolean;
}

export interface PmProcess {
  id: 'gateway' | 'weixin' | 'node';
  label: string;
  running: boolean;
  pid: number | null;
  logFile: string;
}

/** 系统信息 + 进程管理客户端（打当前打开的网关，web 与 gateway 同端口） */
export class PmClient {
  constructor(
    private base: string,
    private getToken: () => string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(this.url(path), jsonFetchInit(this.getToken(), init));
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return res.json().catch(() => ({}));
  }

  async systemInfo(): Promise<SystemInfo> {
    return (await this.request('/api/system/info')) as SystemInfo;
  }

  async status(): Promise<PmProcess[]> {
    const data = (await this.request('/api/pm/status')) as { processes: PmProcess[] };
    return data.processes;
  }

  async start(targets: string[]): Promise<PmProcess[]> {
    const data = (await this.request('/api/pm/start', { method: 'POST', body: JSON.stringify({ targets }) })) as {
      processes: PmProcess[];
    };
    return data.processes;
  }

  async stop(targets: string[]): Promise<PmProcess[]> {
    const data = (await this.request('/api/pm/stop', { method: 'POST', body: JSON.stringify({ targets }) })) as {
      processes: PmProcess[];
    };
    return data.processes;
  }

  /** 重启；targets 含 gateway 时返回 {gateway:true, restarting:true}（网关会短暂中断） */
  async restart(targets: string[]): Promise<{ processes?: PmProcess[]; gateway?: boolean; restarting?: boolean }> {
    return (await this.request('/api/pm/restart', { method: 'POST', body: JSON.stringify({ targets }) })) as {
      processes?: PmProcess[];
      gateway?: boolean;
      restarting?: boolean;
    };
  }

  async logs(id: string, tail = 200): Promise<string> {
    const data = (await this.request(`/api/pm/logs/${encodeURIComponent(id)}?tail=${tail}`)) as { content?: string };
    return data.content ?? '';
  }

  /** 读取 weixin/node 挂载网关；url 为空表示挂载本机网关，token 不回明文 */
  async gatewayTargets(): Promise<Record<ChildGatewayId, ChildGatewayTargetInfo>> {
    const data = (await this.request('/api/pm/gateway-targets')) as {
      targets: Record<ChildGatewayId, ChildGatewayTargetInfo>;
    };
    return data.targets;
  }

  /** 落盘挂载网关并自动重启该进程；url 传空串切回本机网关 */
  async setGatewayTarget(
    id: ChildGatewayId,
    url: string,
    token: string,
  ): Promise<{ processes: PmProcess[]; targets: Record<ChildGatewayId, ChildGatewayTargetInfo> }> {
    return (await this.request(`/api/pm/gateway-targets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ url, token }),
    })) as { processes: PmProcess[]; targets: Record<ChildGatewayId, ChildGatewayTargetInfo> };
  }
}

/** 可改挂载网关的本机子进程 */
export type ChildGatewayId = 'weixin' | 'node';

/** 子进程挂载网关信息（token 只回是否已配置） */
export interface ChildGatewayTargetInfo {
  /** 远程网关地址；空串表示本机网关 */
  url: string;
  /** 是否挂载本机网关 */
  local: boolean;
  /** 是否已配置回连 token */
  tokenConfigured: boolean;
}

// ── 渠道终端 / 任务 / Key / 节点（渠道终端≠系统账号，仅为渠道侧匿名会话作用域）──

/** 渠道终端摘要（/api/users） */
export interface ChannelUserSummary {
  channel: string;
  userId: string;
  ownerUsername?: string;
  activeTaskId: string;
  taskCount: number;
  updatedAt: number;
}

/** 渠道终端级 token 摘要（/api/channel-tokens，不含完整 token） */
export interface ChannelTokenInfo {
  channel: string;
  userId: string;
  ownerUsername?: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  tokenPreview: string;
}

/** 任务（/api/tasks/all 内的 tasks[]） */
export interface TaskItem {
  id: string;
  key?: string;
  keyEnabled?: boolean;
  name: string;
  agentId: string;
  nodeId?: string;
  cwd?: string;
  createdAt: number;
}

/** 单个登录用户的全部会话任务（/api/tasks/all 的 users[]） */
export interface UserTasks {
  channel: string;
  userId: string;
  ownerUsername?: string;
  activeTaskId: string;
  tasks: TaskItem[];
}

/** 节点准入状态：approved=已批准；pending=待审批；blocked=已拒绝 */
export type NodeAdmissionStatus = 'approved' | 'pending' | 'blocked';

/** 节点（/api/nodes） */
export interface NodeInfo {
  nodeId: string;
  name: string;
  online: boolean;
  agents: { id: string; displayName?: string }[];
  version?: string;
  status?: NodeAdmissionStatus;
  connectedAt?: number;
  lastSeenAt?: number;
  remoteAddress?: string;
  ownerUsername?: string;
  /** 是否被管理员临时停用；true 时不参与路由，连接被关 */
  disabled?: boolean;
}

/** 节点接入信息（/api/nodes/enroll）：用于生成 env 与启动命令 */
export interface NodeEnrollInfo {
  host: string;
  port: number;
  authEnabled: boolean;
  /** 网关静态令牌（仅管理员回显；未开鉴权 / 普通用户为空串） */
  token: string;
  defaultAgents: { id: string; displayName?: string }[];
}

export interface NodeTokenInfo {
  id: string;
  tokenPreview: string;
  label?: string;
  nodeId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** 用户默认偏好（新建任务预填节点+agent） */
export interface UserPreference {
  defaultNodeId: string | null;
  defaultAgentId: string | null;
}

/** 任务/用户/Key/节点运维客户端（沿用 Bearer token） */
export class OpsClient {
  constructor(
    private base: string,
    private getToken: () => string,
  ) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(this.url(path), jsonFetchInit(this.getToken(), init));
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return res.json().catch(() => ({}));
  }

  // ── 渠道终端 ──
  async listUsers(): Promise<ChannelUserSummary[]> {
    const data = (await this.request('/api/users')) as { users: ChannelUserSummary[] };
    return data.users;
  }

  async deleteUser(channel: string, userId: string): Promise<void> {
    await this.request(`/api/users/${encodeURIComponent(channel)}/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  async getPreference(channel: string, userId: string): Promise<UserPreference> {
    return (await this.request(
      `/api/users/${encodeURIComponent(channel)}/${encodeURIComponent(userId)}/preferences`,
    )) as UserPreference;
  }

  async setPreference(channel: string, userId: string, nodeId: string, agentId: string): Promise<UserPreference> {
    return (await this.request(
      `/api/users/${encodeURIComponent(channel)}/${encodeURIComponent(userId)}/preferences`,
      { method: 'PUT', body: JSON.stringify({ nodeId, agentId }) },
    )) as UserPreference;
  }

  // ── 任务 ──
  async listAllTasks(): Promise<UserTasks[]> {
    const data = (await this.request('/api/tasks/all')) as { users: UserTasks[] };
    return data.users;
  }

  /** 全局默认 agent（config.yaml tasks.defaultAgentId），新建任务缺省绑定它 */
  async getDefaultAgent(): Promise<string> {
    const data = (await this.request('/api/tasks/default-agent')) as { defaultAgentId: string };
    return data.defaultAgentId;
  }

  async createTask(input: {
    channel: string;
    userId: string;
    name: string;
    agentId?: string;
    nodeId?: string;
    key?: string;
    cwd?: string;
    ownerUsername?: string;
  }): Promise<TaskItem> {
    return (await this.request('/api/tasks', { method: 'POST', body: JSON.stringify(input) })) as TaskItem;
  }

  async patchTask(
    channel: string,
    userId: string,
    taskId: string,
    patch: { name?: string; keyEnabled?: boolean; cwd?: string | null },
    ownerUsername?: string,
  ): Promise<TaskItem> {
    const data = (await this.request(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ channel, userId, ...patch, ...(ownerUsername ? { ownerUsername } : {}) }),
    })) as { task: TaskItem };
    return data.task;
  }

  async setTaskAgent(
    channel: string,
    userId: string,
    taskId: string,
    agentId: string,
    nodeId?: string,
    ownerUsername?: string,
  ): Promise<TaskItem> {
    const data = (await this.request(`/api/tasks/${encodeURIComponent(taskId)}/agent`, {
      method: 'PATCH',
      body: JSON.stringify({
        channel,
        userId,
        agentId,
        ...(nodeId ? { nodeId } : {}),
        ...(ownerUsername ? { ownerUsername } : {}),
      }),
    })) as { task: TaskItem };
    return data.task;
  }

  async activateTask(channel: string, userId: string, taskId: string, ownerUsername?: string): Promise<TaskItem> {
    const data = (await this.request(`/api/tasks/${encodeURIComponent(taskId)}/activate`, {
      method: 'PATCH',
      body: JSON.stringify({ channel, userId, ...(ownerUsername ? { ownerUsername } : {}) }),
    })) as { task: TaskItem };
    return data.task;
  }

  async deleteTask(channel: string, userId: string, taskId: string, ownerUsername?: string): Promise<void> {
    const q = new URLSearchParams({ channel, userId });
    if (ownerUsername) q.set('owner', ownerUsername);
    await this.request(`/api/tasks/${encodeURIComponent(taskId)}?${q.toString()}`, { method: 'DELETE' });
  }

  // ── 渠道终端级 token（微信 bot 终端级直连凭据）──
  async listChannelTokens(): Promise<ChannelTokenInfo[]> {
    const data = (await this.request('/api/channel-tokens')) as { tokens: ChannelTokenInfo[] };
    return data.tokens;
  }

  /** 获取或签发某渠道终端 token（幂等）；返回完整 token 本体 */
  async ensureChannelToken(channel: string, userId: string, label?: string): Promise<{ token: string }> {
    return (await this.request('/api/channel-tokens/ensure', {
      method: 'POST',
      body: JSON.stringify({ channel, userId, ...(label ? { label } : {}) }),
    })) as { token: string };
  }

  /** 轮换：吊销旧 token 并签发新 token */
  async rotateChannelToken(channel: string, userId: string): Promise<{ token: string }> {
    return (await this.request('/api/channel-tokens/rotate', {
      method: 'POST',
      body: JSON.stringify({ channel, userId }),
    })) as { token: string };
  }

  /** 按渠道终端吊销其全部 token（列表仅回显预览，故按终端维度吊销） */
  async revokeChannelTokenByUser(channel: string, userId: string): Promise<void> {
    await this.request(
      `/api/channel-tokens/by-user/${encodeURIComponent(channel)}/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  // ── 节点 ──
  async listNodes(): Promise<NodeInfo[]> {
    const data = (await this.request('/api/nodes')) as { nodes: NodeInfo[] };
    return data.nodes;
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
  }

  /** 节点接入信息：网关地址/（管理员）静态 token/默认 agent */
  async nodeEnroll(): Promise<NodeEnrollInfo> {
    return (await this.request('/api/nodes/enroll')) as NodeEnrollInfo;
  }

  async listNodeTokens(): Promise<NodeTokenInfo[]> {
    const data = (await this.request('/api/node-tokens')) as { tokens: NodeTokenInfo[] };
    return data.tokens;
  }

  async issueNodeToken(label?: string): Promise<NodeTokenInfo & { token: string }> {
    return (await this.request('/api/node-tokens', {
      method: 'POST',
      body: JSON.stringify(label?.trim() ? { label: label.trim() } : {}),
    })) as NodeTokenInfo & { token: string };
  }

  async rotateNodeToken(id: string): Promise<NodeTokenInfo & { token: string }> {
    return (await this.request(`/api/node-tokens/${encodeURIComponent(id)}/rotate`, { method: 'POST' })) as NodeTokenInfo & {
      token: string;
    };
  }

  async revokeNodeToken(id: string): Promise<void> {
    await this.request(`/api/node-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** 批准待审批节点：在线则立即上线，离线则待其凭凭证重连 */
  async approveNode(nodeId: string): Promise<NodeInfo> {
    const data = (await this.request(`/api/nodes/${encodeURIComponent(nodeId)}/approve`, { method: 'POST' })) as {
      node: NodeInfo;
    };
    return data.node;
  }

  /** 拒绝待审批节点：置 blocked 并关闭其连接（节点停止重连） */
  async rejectNode(nodeId: string, reason?: string): Promise<void> {
    await this.request(`/api/nodes/${encodeURIComponent(nodeId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  /** 临时停用节点：在线则关连接，路由层忽略；后续重连被拒 */
  async disableNode(nodeId: string, reason?: string): Promise<NodeInfo> {
    const data = (await this.request(`/api/nodes/${encodeURIComponent(nodeId)}/disable`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    })) as { node: NodeInfo };
    return data.node;
  }

  /** 解除停用：节点下次重连可恢复 */
  async enableNode(nodeId: string): Promise<NodeInfo> {
    const data = (await this.request(`/api/nodes/${encodeURIComponent(nodeId)}/enable`, {
      method: 'POST',
    })) as { node: NodeInfo };
    return data.node;
  }

  /** 节点 + 其上可路由 agent（任务弹窗级联选择用） */
  async nodeAgents(): Promise<{
    local?: { nodeId: string; name: string; online: boolean; agents: { id: string; displayName?: string }[] };
    nodes: NodeInfo[];
    agents: { id: string; displayName?: string }[];
  }> {
    return (await this.request('/api/node-agents')) as {
      local?: { nodeId: string; name: string; online: boolean; agents: { id: string; displayName?: string }[] };
      nodes: NodeInfo[];
      agents: { id: string; displayName?: string }[];
    };
  }
}
