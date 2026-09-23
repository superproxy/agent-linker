import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type {
  GatewayToNode,
  NodeAdmissionStatus,
  NodeInfo,
  NodeToGateway,
  NodeTurnEvent,
  NodeTurnResult,
} from '@linkagent/shared';
import { RemoteNodeAdapter } from '../agents/remoteWrapper.js';
import { isPersonalTokenShape } from '../users/personal-token-store.js';
import { isNodeClaimShape } from '../users/node-claim-store.js';
import { TASK_KEY_PREFIX } from '../tasks/types.js';
import { NodeOfflineError, type NodeLink, type RemoteTurnRequest } from './link.js';
import type { NodeRecord, NodeRegistry } from './store.js';

const NODE_WS_PATH = '/api/nodes/ws';
const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 15_000;
const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface PendingTurn {
  resolve(result: NodeTurnResult): void;
  reject(err: Error): void;
  onEvent(ev: NodeTurnEvent): void;
}

interface NodeConnection extends NodeLink {
  readonly ws: WebSocket;
  name: string;
  agents: NodeInfo['agents'];
  version?: string;
  /** false=已连上但尚待管理员审批（保活、不可路由）；true=已准入 */
  approved: boolean;
  connectedAt: number;
  lastSeenAt: number;
  remoteAddress?: string;
  isAlive: boolean;
  readonly pending: Map<string, PendingTurn>;
}

export interface NodeManagerOptions {
  registry: NodeRegistry;
  /** 网关开启鉴权时的静态令牌：携带正确令牌的节点直连上线；空串/undefined 表示不校验（全部自动批准） */
  expectedToken?: string;
  /** 用户颁发的机器 token 反查（nt_）；命中则直连上线并归属该用户 */
  resolveNodeToken?: (token: string) => { username: string; nodeId?: string } | null;
  /** 首次握手将 token 锁定到 nodeId */
  bindNodeToken?: (token: string, nodeId: string) => boolean;
  /** 匿名申请 hello.claimToken（nu_）反查属主 */
  resolveNodeClaim?: (claimToken: string) => string | null;
  pingIntervalMs?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/** 节点上下线变化回调（AgentManager 据此增删 RemoteNodeAdapter；待审批连接不触发） */
export type NodeChangeListener = (nodeId: string, online: boolean) => void;

function newNodeId(): string {
  return `n_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 网关为节点签发的重连凭证（审批通过后节点凭它免静态令牌重连） */
function newNodeSecret(): string {
  return randomBytes(32).toString('hex');
}

function secretEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

type UpgradeAuth =
  | { kind: 'none' }
  | { kind: 'open' }
  | { kind: 'gateway' }
  | { kind: 'invalid'; reason?: 'pat' | 'task-key' | 'claim' }
  | { kind: 'node'; username: string; token: string; boundNodeId?: string };

/** 管理远程节点的 WebSocket 连接、准入审批、心跳、turn 多路复用与注册信息持久化 */
export class NodeManager {
  private readonly registry: NodeRegistry;
  private readonly expectedToken: string;
  private readonly resolveNodeToken?: NodeManagerOptions['resolveNodeToken'];
  private readonly bindNodeToken?: NodeManagerOptions['bindNodeToken'];
  private readonly resolveNodeClaim?: NodeManagerOptions['resolveNodeClaim'];
  private readonly logger: NonNullable<NodeManagerOptions['logger']>;
  private readonly wss = new WebSocketServer({ noServer: true });
  /** 含待审批连接（approved=false）；路由相关方法只认 approved 连接 */
  private readonly connections = new Map<string, NodeConnection>();
  private readonly listeners = new Set<NodeChangeListener>();
  private readonly pingTimer: NodeJS.Timeout;

  constructor(options: NodeManagerOptions) {
    this.registry = options.registry;
    this.expectedToken = options.expectedToken ?? '';
    this.resolveNodeToken = options.resolveNodeToken;
    this.bindNodeToken = options.bindNodeToken;
    this.resolveNodeClaim = options.resolveNodeClaim;
    this.logger = options.logger ?? {
      info: (m) => console.log(`[nodes] ${m}`),
      warn: (m) => console.warn(`[nodes] ${m}`),
      error: (m) => console.error(`[nodes] ${m}`),
    };
    const interval = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.checkHeartbeats(), interval);
    this.pingTimer.unref?.();
  }

  onChange(fn: NodeChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitChange(nodeId: string, online: boolean): void {
    for (const fn of this.listeners) {
      try {
        fn(nodeId, online);
      } catch (err) {
        this.logger.error(`节点变化回调异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * http server 'upgrade' 事件入口：仅接受 /api/nodes/ws。
   * - 携带正确静态令牌（query/bearer）→ 预鉴权通过，握手直接上线
   * - 携带了错误令牌 → 401 拒绝
   * - 匿名（不带令牌）→ 放行，由 hello 阶段决定（凭证重连 / 申请待审批）
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    if (path !== NODE_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.expectedToken) {
      const check = this.classifyUpgradeToken(req);
      if (check.kind === 'invalid') {
        const hint =
          check.reason === 'pat'
            ? 'personal API token (pat_) is not valid for node WebSocket; use nt_ machine token from the admin UI'
            : check.reason === 'task-key'
              ? 'task key (k_) is not valid for node WebSocket; use nt_ machine token'
              : 'gateway token or nt_ machine token required';
        socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${hint}`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws, req, check));
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws, req, { kind: 'open' }));
  }

  private readProvidedToken(req: IncomingMessage): string {
    const url = new URL(req.url ?? '', 'http://localhost');
    const qToken = url.searchParams.get('token') ?? '';
    const h = req.headers.authorization ?? '';
    const bearer = h.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
    return (qToken || bearer).trim();
  }

  /** 网关 token、用户机器 token 都可通过；错误令牌拒绝；未携带走匿名/凭证重连 */
  private classifyUpgradeToken(req: IncomingMessage): UpgradeAuth {
    const provided = this.readProvidedToken(req);
    if (!provided) return { kind: 'none' };
    if (this.expectedToken && provided === this.expectedToken) return { kind: 'gateway' };
    const nt = this.resolveNodeToken?.(provided);
    if (nt) return { kind: 'node', username: nt.username, token: provided, boundNodeId: nt.nodeId };
    if (isPersonalTokenShape(provided)) {
      this.logger.warn('节点 upgrade 使用了 pat_ 个人 API token；请改用后台颁发的 nt_ 机器凭证');
      return { kind: 'invalid', reason: 'pat' };
    }
    if (provided.startsWith(TASK_KEY_PREFIX)) {
      this.logger.warn('节点 upgrade 使用了 k_ 任务 key；请改用 nt_ 机器凭证');
      return { kind: 'invalid', reason: 'task-key' };
    }
    if (isNodeClaimShape(provided)) {
      this.logger.warn(
        '节点 upgrade 使用了 nu_ 归属申明码；请改用环境变量 LINKAGENT_NODE_CLAIM，Upgrade 不要带 Bearer',
      );
      return { kind: 'invalid', reason: 'claim' };
    }
    return { kind: 'invalid' };
  }

  /** 节点连接是否已准入且在线（待审批返回 false；被管理员禁用返回 false） */
  isOnline(nodeId: string): boolean {
    if (this.registry.get(nodeId)?.disabled === true) return false;
    return this.connections.get(nodeId)?.approved === true;
  }

  /** 取已准入且未被禁用的节点链路（供 RemoteNodeAdapter）；其他情形返回 undefined */
  getLink(nodeId: string): NodeLink | undefined {
    if (this.registry.get(nodeId)?.disabled === true) return undefined;
    const conn = this.connections.get(nodeId);
    return conn?.approved ? conn : undefined;
  }

  /** 已准入在线节点的自报 agent id 列表（任务绑定校验用，被禁用时返回空） */
  onlineAgentIds(nodeId: string): string[] {
    if (this.registry.get(nodeId)?.disabled === true) return [];
    const conn = this.connections.get(nodeId);
    return conn?.approved ? conn.agents.map((a) => a.id) : [];
  }

  /** 合并注册记录与连接，返回全部节点（含离线、待审批）；local 节点由 REST 层自行置顶 */
  list(): NodeInfo[] {
    const byId = new Map<string, NodeInfo>();
    for (const rec of this.registry.list()) {
      byId.set(rec.nodeId, this.toInfo(rec, this.connections.get(rec.nodeId)));
    }
    for (const [nodeId, conn] of this.connections) {
      if (!byId.has(nodeId)) byId.set(nodeId, this.toInfo(undefined, conn));
    }
    return [...byId.values()].sort(
      (a, b) =>
        Number(b.online) - Number(a.online)
        || Number(b.status === 'pending') - Number(a.status === 'pending')
        || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
    );
  }

  private toInfo(rec: NodeRecord | undefined, conn: NodeConnection | undefined): NodeInfo {
    const status: NodeAdmissionStatus = rec?.status ?? 'approved';
    const disabled = rec?.disabled === true;
    return {
      nodeId: rec?.nodeId ?? conn!.nodeId,
      name: conn?.name ?? rec?.name ?? rec?.nodeId ?? '',
      // 待审批连接虽保活，但在路由意义上尚未上线；被禁用同上
      online: conn?.approved === true && !disabled,
      agents: conn?.agents ?? rec?.agents ?? [],
      version: conn?.version ?? rec?.version,
      status: conn && !conn.approved ? 'pending' : status,
      connectedAt: conn?.connectedAt,
      lastSeenAt: conn?.lastSeenAt ?? rec?.lastSeenAt,
      remoteAddress: conn?.remoteAddress,
      ...(rec?.ownerUsername ? { ownerUsername: rec.ownerUsername } : {}),
      ...(disabled ? { disabled: true } : {}),
    };
  }

  /**
   * 删除节点注册记录：
   *   - 已准入在线 → 抛错（先断开）
   *   - 待审批连接 → 关闭其连接并删除
   *   - 不存在 → 抛错
   */
  removeNode(nodeId: string): void {
    const rec = this.registry.get(nodeId);
    if (!rec) throw new Error(`节点不存在: ${nodeId}`);
    const conn = this.connections.get(nodeId);
    // 已停用：连接可能尚在 close 回调前残留，仍允许删注册
    if (conn?.approved && rec.disabled !== true) {
      throw new Error('节点在线，不能删除（请先断开节点连接）');
    }
    if (conn) {
      try {
        conn.ws.close(4404, 'registration removed');
      } catch {
        conn.ws.terminate();
      }
      this.connections.delete(nodeId);
    }
    this.registry.remove(nodeId);
  }

  /** 批准待审批节点：在线则就地升级为已上线；离线则仅改状态，待其凭 secret 重连 */
  approveNode(nodeId: string): NodeInfo {
    const rec = this.registry.get(nodeId);
    if (!rec) throw new Error(`节点不存在: ${nodeId}`);
    if ((rec.status ?? 'approved') !== 'pending') throw new Error(`节点 ${nodeId} 不在待审批状态`);
    const next: NodeRecord = { ...rec, status: 'approved', lastSeenAt: Date.now() };
    this.registry.upsert(next);

    const conn = this.connections.get(nodeId);
    if (conn && !conn.approved) {
      conn.approved = true;
      this.send(conn.ws, { type: 'approved', secret: rec.secret ?? '' });
      this.logger.info(`节点准入批准: ${nodeId}（${conn.name}）`);
      this.emitChange(nodeId, true);
    } else {
      this.logger.info(`节点准入批准（离线）: ${nodeId}，待其重连上线`);
    }
    return this.toInfo(next, conn);
  }

  /** 拒绝待审批节点：置 blocked 并关闭其连接（节点停止重连）；已准入节点需先断开/删除 */
  rejectNode(nodeId: string, reason = '管理员拒绝接入'): void {
    const rec = this.registry.get(nodeId);
    if (!rec) throw new Error(`节点不存在: ${nodeId}`);
    if ((rec.status ?? 'approved') === 'approved' && this.isOnline(nodeId)) {
      throw new Error('节点已准入且在线，不能拒绝（请先删除或断开）');
    }
    this.registry.upsert({ ...rec, status: 'blocked', lastSeenAt: Date.now() });
    const conn = this.connections.get(nodeId);
    if (conn) {
      this.send(conn.ws, { type: 'rejected', reason });
      try {
        conn.ws.close(4403, 'rejected');
      } catch {
        conn.ws.terminate();
      }
      this.connections.delete(nodeId);
    }
    this.logger.warn(`节点准入拒绝: ${nodeId}`);
  }

  /**
   * 管理员临时停用节点（独立于 status/准入）：
   *   - 持久化 disabled=true，路由层忽略该节点
   *   - 在线连接立即关闭（节点凭 secret 重连仍被拒）
   *   - 待审批连接也立即关闭（避免继续保活）
   * 返回更新后的 NodeInfo
   */
  disableNode(nodeId: string, reason = '管理员停用该节点'): NodeInfo {
    const rec = this.registry.get(nodeId);
    if (!rec) throw new Error(`节点不存在: ${nodeId}`);
    const next: NodeRecord = { ...rec, disabled: true, lastSeenAt: Date.now() };
    this.registry.upsert(next);
    const conn = this.connections.get(nodeId);
    const wasApproved = conn?.approved === true;
    if (conn) {
      this.send(conn.ws, { type: 'rejected', reason });
      try {
        conn.ws.close(4408, 'disabled');
      } catch {
        conn.ws.terminate();
      }
    }
    this.logger.warn(`节点停用: ${nodeId}`);
    if (wasApproved) this.emitChange(nodeId, false);
    return this.toInfo(next, conn);
  }

  /** 解除停用；不主动连，等节点下次凭 secret/令牌重连；已为启用态时幂等 */
  enableNode(nodeId: string): NodeInfo {
    const rec = this.registry.get(nodeId);
    if (!rec) throw new Error(`节点不存在: ${nodeId}`);
    if (rec.disabled !== true) return this.toInfo(rec, this.connections.get(nodeId));
    const next: NodeRecord = { ...rec, disabled: false, lastSeenAt: Date.now() };
    this.registry.upsert(next);
    this.logger.info(`节点启用: ${nodeId}`);
    return this.toInfo(next, this.connections.get(nodeId));
  }

  /** 为已准入在线节点的每个自报 agent 创建远程适配器 */
  createAdapters(nodeId: string, factory: (agentId: string, link: NodeLink, displayName?: string) => RemoteNodeAdapter): RemoteNodeAdapter[] {
    const conn = this.connections.get(nodeId);
    if (!conn || !conn.approved) return [];
    return conn.agents.map((a) => factory(a.id, conn, a.displayName));
  }

  private checkHeartbeats(): void {
    for (const [nodeId, conn] of this.connections) {
      if (!conn.isAlive) {
        this.logger.warn(`节点 ${nodeId} 心跳超时，断开连接`);
        conn.ws.terminate();
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  /** 注册一个新连接：等待 hello 完成握手 */
  private handleConnection(ws: WebSocket, req: IncomingMessage, upgradeAuth: UpgradeAuth): void {
    const remoteAddress = req.socket.remoteAddress;
    const helloTimer = setTimeout(() => {
      this.logger.warn('节点连接在超时内未发送 hello，关闭');
      try {
        ws.close(4001, 'hello timeout');
      } catch {
        ws.terminate();
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const onHello = (raw: RawData) => {
      let msg: NodeToGateway;
      try {
        msg = JSON.parse(raw.toString()) as NodeToGateway;
      } catch {
        return;
      }
      if (msg.type !== 'hello') return;
      ws.off('message', onHello);
      clearTimeout(helloTimer);
      this.completeHandshake(ws, msg, remoteAddress, upgradeAuth);
    };
    ws.on('message', onHello);
    ws.on('error', () => {
      clearTimeout(helloTimer);
    });
  }

  private completeHandshake(
    ws: WebSocket,
    hello: Extract<NodeToGateway, { type: 'hello' }>,
    remoteAddress: string | undefined,
    upgradeAuth: UpgradeAuth,
  ): void {
    const agents = Array.isArray(hello.agents) ? hello.agents.filter((a) => a && typeof a.id === 'string') : [];

    const helloNode = hello.token ? this.resolveNodeToken?.(hello.token) : null;
    const nodeAuth: UpgradeAuth | null =
      upgradeAuth.kind === 'node'
        ? upgradeAuth
        : helloNode && hello.token
          ? { kind: 'node', username: helloNode.username, token: hello.token, boundNodeId: helloNode.nodeId }
          : null;

    const gatewayOk =
      upgradeAuth.kind === 'gateway' ||
      upgradeAuth.kind === 'open' ||
      (this.expectedToken !== '' && hello.token === this.expectedToken);
    const authDisabled = upgradeAuth.kind === 'open' || this.expectedToken === '';

    if (nodeAuth) {
      this.admit(ws, hello, agents, remoteAddress, {
        mode: 'node',
        username: nodeAuth.username,
        token: nodeAuth.token,
        boundNodeId: nodeAuth.boundNodeId,
      });
      return;
    }

    if (gatewayOk || authDisabled) {
      this.admit(ws, hello, agents, remoteAddress, { mode: 'token' });
      return;
    }

    // hello 携带了既非网关也非 nt_ 的令牌 → 拒绝
    if (hello.token) {
      this.logger.warn('节点 hello token 校验失败，关闭连接');
      try {
        ws.close(4401, 'unauthorized');
      } catch {
        ws.terminate();
      }
      return;
    }

    // 3) 节点凭证（nodeId + secret）重连
    const requested = hello.nodeId?.trim();
    const rec = requested && NODE_ID_PATTERN.test(requested) ? this.registry.get(requested) : null;

    // 被管理员临时停用：所有重连入口（token / node / secret）一律拒绝
    if (rec?.disabled === true) {
      this.send(ws, { type: 'rejected', reason: '该节点已被管理员停用' });
      try {
        ws.close(4408, 'disabled');
      } catch {
        ws.terminate();
      }
      this.logger.warn(`被禁用节点 ${rec.nodeId} 尝试重连，关闭`);
      return;
    }

    if (rec && rec.secret && secretEqual(hello.secret, rec.secret)) {
      const status = rec.status ?? 'approved';
      if (status === 'blocked') {
        this.send(ws, { type: 'rejected', reason: '该节点已被拒绝接入' });
        try {
          ws.close(4403, 'blocked');
        } catch {
          ws.terminate();
        }
        this.logger.warn(`被拒绝节点 ${rec.nodeId} 凭凭证重连，再次关闭`);
        return;
      }
      // approved → 上线；pending → 继续等待审批（连接保活）
      this.admit(ws, hello, agents, remoteAddress, {
        mode: 'secret',
        nodeId: rec.nodeId,
        approved: status === 'approved',
        secret: rec.secret,
      });
      return;
    }

    // 4) 匿名申请：进入待审批（nodeId 缺失/非法/已被占用时网关注发新身份，防冒名）
    const claimed = requested && NODE_ID_PATTERN.test(requested) && !this.registry.get(requested) ? requested : newNodeId();
    const claimRaw = hello.claimToken?.trim();
    let ownerUsername: string | undefined;
    if (claimRaw) {
      const user = this.resolveNodeClaim?.(claimRaw);
      if (user) ownerUsername = user;
      else this.logger.warn('节点申请携带无效或过期的 nu_ 归属申明码，属主留空');
    }
    this.applyForAdmission(ws, hello, agents, remoteAddress, claimed, ownerUsername);
  }

  /** 已准入上线（令牌直连或凭证重连） */
  private admit(
    ws: WebSocket,
    hello: Extract<NodeToGateway, { type: 'hello' }>,
    agents: NodeInfo['agents'],
    remoteAddress: string | undefined,
    opts:
      | { mode: 'token' }
      | { mode: 'secret'; nodeId: string; approved: boolean; secret: string }
      | { mode: 'node'; username: string; token: string; boundNodeId?: string },
  ): void {
    let nodeId: string;
    let approved: boolean;
    let secret: string | undefined;
    let ownerUsername: string | undefined;

    if (opts.mode === 'token') {
      const requested = hello.nodeId?.trim();
      nodeId = requested && NODE_ID_PATTERN.test(requested) ? requested : newNodeId();
      approved = true;
    } else if (opts.mode === 'node') {
      if (opts.boundNodeId) {
        const claimed = hello.nodeId?.trim();
        if (claimed && claimed !== opts.boundNodeId) {
          this.logger.warn(`机器 token 已绑定 ${opts.boundNodeId}，拒绝冒用 ${claimed}`);
          try {
            ws.close(4401, 'token bound to another node');
          } catch {
            ws.terminate();
          }
          return;
        }
        nodeId = opts.boundNodeId;
      } else {
        const requested = hello.nodeId?.trim();
        nodeId = requested && NODE_ID_PATTERN.test(requested) ? requested : newNodeId();
      }
      approved = true;
      ownerUsername = opts.username;
      if (this.bindNodeToken && !this.bindNodeToken(opts.token, nodeId)) {
        this.logger.warn('机器 token 绑定节点失败，关闭连接');
        try {
          ws.close(4401, 'unauthorized');
        } catch {
          ws.terminate();
        }
        return;
      }
    } else {
      nodeId = opts.nodeId;
      approved = opts.approved;
      secret = opts.secret;
    }

    // 同 nodeId 旧连接（含待审批）：踢掉。onDisconnect 用 ws 身份比对，旧连接关闭不清新连接
    const existing = this.connections.get(nodeId);
    if (existing) {
      this.logger.info(`节点 ${nodeId} 重新连接，替换旧连接`);
      try {
        existing.ws.close(4000, 'replaced by new connection');
      } catch {
        existing.ws.terminate();
      }
    }

    const now = Date.now();
    const prevRec = this.registry.get(nodeId);
    // 令牌直连的新节点也签发凭证，便于其日后免静态令牌重连
    if (!secret) secret = prevRec?.secret ?? newNodeSecret();

    const conn: NodeConnection = {
      ws,
      nodeId,
      name: hello.name?.trim() || nodeId,
      agents,
      ...(hello.version ? { version: hello.version } : {}),
      approved,
      connectedAt: now,
      lastSeenAt: now,
      ...(remoteAddress ? { remoteAddress } : {}),
      isAlive: true,
      pending: new Map(),
      online: approved,
      runTurn: (req, onEvent, signal) => this.runTurn(nodeId, req, onEvent, signal),
    };
    this.connections.set(nodeId, conn);

    const rec: NodeRecord = {
      nodeId,
      name: conn.name,
      agents,
      ...(conn.version ? { version: conn.version } : {}),
      // 凭证重连且记录仍 pending 时保持 pending（等待管理员批准）；其余为 approved
      status: approved ? 'approved' : prevRec?.status === 'blocked' ? 'blocked' : 'pending',
      secret,
      ...(ownerUsername ?? prevRec?.ownerUsername
        ? { ownerUsername: ownerUsername ?? prevRec?.ownerUsername }
        : {}),
      createdAt: prevRec?.createdAt ?? now,
      lastSeenAt: now,
    };
    this.registry.upsert(rec);

    this.send(ws, { type: 'welcome', nodeId, approved, secret });

    if (approved) {
      this.logger.info(`节点上线: ${nodeId}（${conn.name}）agents=${agents.map((a) => a.id).join(',') || '无'}`);
      this.emitChange(nodeId, true);
    } else {
      // 凭证重连但记录仍 pending（一般发生在审批下发前网络重连）
      this.logger.info(`待审批节点重连: ${nodeId}（${conn.name}），继续等待审批`);
    }

    ws.on('pong', () => {
      conn.isAlive = true;
      conn.lastSeenAt = Date.now();
    });
    ws.on('message', (raw) => this.onNodeMessage(nodeId, raw));
    ws.on('close', () => this.onDisconnect(nodeId, ws));
    ws.on('error', () => {
      // close 事件会紧随其后，统一在 onDisconnect 清理
    });
  }

  /** 匿名节点申请：落 pending 记录、保活连接、下发 secret 与 welcome(approved=false) */
  private applyForAdmission(
    ws: WebSocket,
    hello: Extract<NodeToGateway, { type: 'hello' }>,
    agents: NodeInfo['agents'],
    remoteAddress: string | undefined,
    nodeId: string,
    ownerUsername?: string,
  ): void {
    const existing = this.connections.get(nodeId);
    if (existing) {
      try {
        existing.ws.close(4000, 'replaced by new connection');
      } catch {
        existing.ws.terminate();
      }
    }

    const now = Date.now();
    const secret = newNodeSecret();
    const conn: NodeConnection = {
      ws,
      nodeId,
      name: hello.name?.trim() || nodeId,
      agents,
      ...(hello.version ? { version: hello.version } : {}),
      approved: false,
      connectedAt: now,
      lastSeenAt: now,
      ...(remoteAddress ? { remoteAddress } : {}),
      isAlive: true,
      pending: new Map(),
      online: false,
      runTurn: () => Promise.reject(new Error('节点尚未通过审批')),
    };
    this.connections.set(nodeId, conn);

    this.registry.upsert({
      nodeId,
      name: conn.name,
      agents,
      ...(conn.version ? { version: conn.version } : {}),
      status: 'pending',
      secret,
      ...(ownerUsername ? { ownerUsername } : {}),
      createdAt: now,
      lastSeenAt: now,
    });

    this.send(ws, { type: 'welcome', nodeId, approved: false, secret });
    const ownerHint = ownerUsername ? `，属主=${ownerUsername}` : '';
    this.logger.info(
      `节点申请准入: ${nodeId}（${conn.name}）agents=${agents.map((a) => a.id).join(',') || '无'}${ownerHint}，等待管理员审批`,
    );

    ws.on('pong', () => {
      conn.isAlive = true;
      conn.lastSeenAt = Date.now();
    });
    ws.on('message', (raw) => this.onNodeMessage(nodeId, raw));
    ws.on('close', () => this.onDisconnect(nodeId, ws));
    ws.on('error', () => {});
  }

  private onNodeMessage(nodeId: string, raw: RawData): void {
    const conn = this.connections.get(nodeId);
    if (!conn) return;
    conn.lastSeenAt = Date.now();
    let msg: NodeToGateway;
    try {
      msg = JSON.parse(raw.toString()) as NodeToGateway;
    } catch {
      return;
    }
    if (msg.type === 'pong') {
      conn.isAlive = true;
      return;
    }
    // 待审批节点不接受任何 turn 消息
    if (!conn.approved) return;
    if (msg.type === 'turnEvent' || msg.type === 'turnResult' || msg.type === 'turnError') {
      const pending = conn.pending.get(msg.requestId);
      if (!pending) return;
      if (msg.type === 'turnEvent') {
        pending.onEvent(msg.event);
      } else if (msg.type === 'turnResult') {
        conn.pending.delete(msg.requestId);
        pending.resolve(msg.result);
      } else {
        conn.pending.delete(msg.requestId);
        pending.reject(new Error(msg.message || '远程 agent 执行失败'));
      }
    }
  }

  private runTurn(
    nodeId: string,
    req: RemoteTurnRequest,
    onEvent: (ev: NodeTurnEvent) => void,
    signal?: AbortSignal,
  ): Promise<NodeTurnResult> {
    return new Promise<NodeTurnResult>((resolve, reject) => {
      const conn = this.connections.get(nodeId);
      if (!conn || !conn.approved) {
        reject(new NodeOfflineError(nodeId));
        return;
      }
      const requestId = randomUUID();
      if (signal?.aborted) {
        reject(new Error('请求已取消'));
        return;
      }
      const message: GatewayToNode = {
        type: 'turn',
        requestId,
        agentId: req.agentId,
        text: req.text,
        ...(req.model ? { model: req.model } : {}),
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(req.sessionKey ? { sessionKey: req.sessionKey } : {}),
        ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        this.send(conn.ws, { type: 'cancel', requestId });
        const p = conn.pending.get(requestId);
        if (p) {
          conn.pending.delete(requestId);
          p.reject(new Error('请求已取消'));
        }
      };
      conn.pending.set(requestId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        onEvent,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send(conn.ws, message);
      } catch (err) {
        conn.pending.delete(requestId);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onDisconnect(nodeId: string, ws: WebSocket): void {
    const conn = this.connections.get(nodeId);
    // 同节点重连时旧连接的 close 可能晚到：连接已被新连接替换，忽略旧连接
    if (!conn || conn.ws !== ws) return;
    const wasApproved = conn.approved;
    this.connections.delete(nodeId);
    // 拒绝所有进行中的 turn
    for (const [requestId, pending] of conn.pending) {
      pending.reject(new NodeOfflineError(nodeId));
      conn.pending.delete(requestId);
    }
    const rec = this.registry.get(nodeId);
    if (rec) this.registry.upsert({ ...rec, lastSeenAt: Date.now() });
    this.logger.info(wasApproved ? `节点离线: ${nodeId}` : `待审批节点断开: ${nodeId}`);
    if (wasApproved) this.emitChange(nodeId, false);
  }

  private send(ws: WebSocket, msg: GatewayToNode): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async dispose(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const [, conn] of this.connections) {
      for (const [, pending] of conn.pending) pending.reject(new NodeOfflineError('网关关闭'));
      try {
        conn.ws.close(1001, 'gateway shutdown');
      } catch {
        conn.ws.terminate();
      }
    }
    this.connections.clear();
    this.wss.close();
  }
}
