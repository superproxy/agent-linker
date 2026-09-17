import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { GatewayToNode, NodeAgentInfo, NodeToGateway, NodeTurnEvent } from '@linkagent/shared';
import { defaultAgentDefinitions } from '@linkagent/shared';
import { getLayout } from '../install/layout.js';
import { AcpEngine, DEFAULT_LABELS, type AcpAgentKind } from '../gateway/agents/acpEngine.js';

/**
 * 远程节点连接器：在「执行 agent 的机器」上运行，主动 WebSocket 连入网关，
 * 收到 turn 消息后用本机 AcpEngine 拉起 ACP agent，事件/结果回传网关。
 *
 * 环境变量：
 *   LINKAGENT_GATEWAY_URL  网关地址（默认 ws://127.0.0.1:8787），自动补 /api/nodes/ws
 *   LINKAGENT_GATEWAY_TOKEN 网关 token（网关开启 auth 时必填）
 *   LINKAGENT_NODE_NAME    节点展示名（默认本机 hostname）
 *   LINKAGENT_NODE_ID      节点 id（缺省首次连接由网关签发并持久化，重连复用）
 *   LINKAGENT_NODE_AGENTS  逗号分隔的 agent id（缺省上报网关默认 4 种：opencode/pi/workbuddy/trace-cli）
 *   LINKAGENT_NODE_STATE_DIR 节点状态目录（默认 .runtime-state/node；本机多实例时各自指定可避免 nodeId 冲突）
 *
 * 两种准入方式：
 *   1) 令牌直连：LINKAGENT_GATEWAY_TOKEN 与网关 auth.token 一致，连上即上线；
 *   2) 审批接入：不提供 token，首次连接进入网关「待审批」队列，管理员在后台批准后才上线。
 *      网关会为节点签发 secret 并持久化到状态目录（node-secret），断线重连自动携带、无需重复审批。
 *      被管理员拒绝后连接器停止重连（需人工处理后重启进程）。
 */

interface ConnectorOptions {
  gatewayUrl: string;
  token?: string;
  name: string;
  nodeId?: string;
  /** 网关为此前申请/已批准节点签发的凭证（持久化在状态目录，重连携带） */
  secret?: string;
  agents: string[];
  stateDir: string;
}

function nodeStateDir(): string {
  return getLayout().nodeState;
}

/** 读取/持久化网关签发的 nodeId（重连复用同一身份） */
function loadPersistedNodeId(dir: string): string | undefined {
  const file = join(dir, 'node-id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}
function persistNodeId(dir: string, nodeId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node-id'), nodeId, 'utf8');
}

/** 读取/持久化网关签发的节点凭证 secret（审批模式重连复用，免再次审批） */
function loadPersistedSecret(dir: string): string | undefined {
  const file = join(dir, 'node-secret');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}
function persistSecret(dir: string, secret: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node-secret'), secret, { encoding: 'utf8', mode: 0o600 });
}

function buildWsUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\//.test(base)) {
    // 允许填 http(s)://host 或 host:port
    base = base.startsWith('http://') ? base.replace(/^http/, 'ws') : `ws://${base}`;
  }
  if (!base.endsWith('/api/nodes/ws')) base = `${base}/api/nodes/ws`;
  return base;
}

class NodeConnector {
  private readonly opts: ConnectorOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  /** 被管理员明确拒绝：停止重连，等待人工处理后重启进程 */
  private rejected = false;
  /** 是否已通过准入（令牌直连 welcome.approved=true，或收到 approved 消息） */
  private admitted = false;
  private reconnectAttempt = 0;
  /** agentId → 本机引擎（懒创建，按 agent 隔离会话状态目录） */
  private readonly engines = new Map<string, AcpEngine>();
  /** requestId → AbortController */
  private readonly turns = new Map<string, AbortController>();

  constructor(opts: ConnectorOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.turns.values()) c.abort();
    this.ws?.close(1001, 'node shutdown');
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped && !this.rejected) {
      try {
        await this.connectOnce();
        // 正常返回说明连接已关闭，退避后重连
      } catch (err) {
        console.error(`[node] 连接失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped || this.rejected) break;
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
      console.log(`[node] ${delay / 1000}s 后重连…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = buildWsUrl(this.opts.gatewayUrl);
      const ws = new WebSocket(url, this.opts.token ? { headers: { Authorization: `Bearer ${this.opts.token}` } } : undefined);
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.reconnectAttempt = 0;
        const hello: NodeToGateway = {
          type: 'hello',
          ...(this.opts.token ? { token: this.opts.token } : {}),
          ...(this.opts.secret ? { secret: this.opts.secret } : {}),
          ...(this.opts.nodeId ? { nodeId: this.opts.nodeId } : {}),
          name: this.opts.name,
          version: '0.1.0',
          agents: this.agentInfos(),
        };
        ws.send(JSON.stringify(hello));
        console.log(`[node] 已连接网关 ${url}，节点名=${this.opts.name}，agents=${this.opts.agents.join(',')}`);
      });

      ws.on('message', (raw) => {
        let msg: GatewayToNode;
        try {
          msg = JSON.parse(raw.toString()) as GatewayToNode;
        } catch {
          return;
        }
        if (msg.type === 'welcome') {
          if (!this.opts.nodeId) persistNodeId(this.opts.stateDir, msg.nodeId);
          this.opts.nodeId = msg.nodeId;
          if (msg.secret) {
            this.opts.secret = msg.secret;
            persistSecret(this.opts.stateDir, msg.secret);
          }
          if (msg.approved) {
            this.admitted = true;
            console.log(`[node] 网关注册节点 id=${msg.nodeId}，已准入上线`);
          } else {
            this.admitted = false;
            console.log(`[node] 节点 id=${msg.nodeId} 已提交接入申请，等待管理员在网关后台审批（连接保持，请勿关闭）`);
          }
        } else if (msg.type === 'approved') {
          this.admitted = true;
          this.rejected = false;
          if (msg.secret) {
            this.opts.secret = msg.secret;
            persistSecret(this.opts.stateDir, msg.secret);
          }
          console.log('[node] 管理员已批准接入，节点上线');
        } else if (msg.type === 'rejected') {
          this.admitted = false;
          this.rejected = true;
          console.error(`[node] 管理员拒绝了本节点的接入申请${msg.reason ? `：${msg.reason}` : ''}，停止重连。请联系网关管理员处理后重启节点进程`);
          try {
            ws.close(1000, 'rejected by admin');
          } catch {
            ws.terminate();
          }
        } else if (msg.type === 'ping') {
          const pong: NodeToGateway = { type: 'pong' };
          ws.send(JSON.stringify(pong));
        } else if (msg.type === 'turn') {
          // 尚未通过审批时忽略任务（网关侧也不会向 pending 连接下发 turn）
          if (this.admitted) void this.runTurn(msg);
        } else if (msg.type === 'cancel') {
          this.turns.get(msg.requestId)?.abort();
        }
        // closeSession：空闲关闭由引擎自身管理，持久状态保留，这里无需动作
      });

      ws.on('close', () => {
        for (const c of this.turns.values()) c.abort();
        this.turns.clear();
        if (opened) console.log('[node] 连接已关闭');
        resolve();
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
    });
  }

  private agentInfos(): NodeAgentInfo[] {
    return this.opts.agents.map((id) => ({
      id,
      ...(DEFAULT_LABELS[id as AcpAgentKind] ? { displayName: DEFAULT_LABELS[id as AcpAgentKind].displayName } : {}),
    }));
  }

  private engineFor(agentId: string): AcpEngine {
    let engine = this.engines.get(agentId);
    if (!engine) {
      const kind = (DEFAULT_LABELS[agentId as AcpAgentKind] ? agentId : 'opencode') as AcpAgentKind;
      engine = new AcpEngine({
        id: agentId,
        agentName: kind,
        stateDir: join(this.opts.stateDir, 'acpx', agentId),
      });
      this.engines.set(agentId, engine);
    }
    return engine;
  }

  private send(msg: NodeToGateway): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async runTurn(msg: Extract<GatewayToNode, { type: 'turn' }>): Promise<void> {
    const controller = new AbortController();
    this.turns.set(msg.requestId, controller);
    const emit = (event: NodeTurnEvent) => this.send({ type: 'turnEvent', requestId: msg.requestId, event });
    try {
      const result = await this.engineFor(msg.agentId).runTurn({
        text: msg.text,
        ...(msg.sessionKey ? { sessionKey: msg.sessionKey } : {}),
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
        signal: controller.signal,
        onEvent: emit,
      });
      this.send({ type: 'turnResult', requestId: msg.requestId, result });
    } catch (err) {
      this.send({
        type: 'turnError',
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.turns.delete(msg.requestId);
    }
  }
}

function parseArgs(argv: string[]): Partial<ConnectorOptions> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a?.startsWith('--') && next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out as Partial<ConnectorOptions>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.LINKAGENT_NODE_STATE_DIR?.trim() || nodeStateDir();
  const envNodeId = process.env.LINKAGENT_NODE_ID?.trim();
  const agents = (process.env.LINKAGENT_NODE_AGENTS
    ? process.env.LINKAGENT_NODE_AGENTS.split(',').map((s) => s.trim()).filter(Boolean)
    : defaultAgentDefinitions().map((d) => d.id));
  const connector = new NodeConnector({
    gatewayUrl: args.gatewayUrl ?? process.env.LINKAGENT_GATEWAY_URL ?? 'ws://127.0.0.1:8787',
    ...(process.env.LINKAGENT_GATEWAY_TOKEN ? { token: process.env.LINKAGENT_GATEWAY_TOKEN } : {}),
    name: args.name ?? process.env.LINKAGENT_NODE_NAME ?? `node-${hostname()}`,
    nodeId: envNodeId || loadPersistedNodeId(stateDir),
    // 配置了静态令牌时无需 secret；否则读取审批模式持久化的节点凭证
    ...(process.env.LINKAGENT_GATEWAY_TOKEN ? {} : { secret: loadPersistedSecret(stateDir) }),
    agents,
    stateDir,
  });
  connector.start();

  const shutdown = () => {
    console.log('[node] 关闭中…');
    connector.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
