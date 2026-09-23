import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { GatewayToNode, NodeAgentInfo, NodeToGateway, NodeTurnEvent } from '@linkagent/shared';
import { defaultAgentDefinitions, normalizeAgentId } from '@linkagent/shared';
import { getLayout } from '../install/layout.js';
import { loadSharedConfig, resolveChildRuntime } from '../gateway/config.js';
import {
  AcpEngine,
  DEFAULT_COMMANDS,
  DEFAULT_LABELS,
  resolveAcpKindForAgentId,
  type AcpAgentKind,
} from '../gateway/agents/acpEngine.js';
import { isNodeTokenShape } from '../gateway/users/node-token-store.js';
import { isNodeClaimShape } from '../gateway/users/node-claim-store.js';
import { isPersonalTokenShape } from '../gateway/users/personal-token-store.js';
import { TASK_KEY_PREFIX } from '../gateway/tasks/types.js';

/**
 * 远程节点连接器：在「执行 agent 的机器」上运行，主动 WebSocket 连入网关，
 * 收到 turn 消息后用本机 AcpEngine 拉起 ACP agent，事件/结果回传网关。
 *
 * 环境变量：
 *   LINKAGENT_GATEWAY_URL  网关地址（默认 ws://127.0.0.1:8787），自动补 /api/nodes/ws
 *   LINKAGENT_GATEWAY_TOKEN 网关 token（网关开启 auth 时必填）
 *   LINKAGENT_NODE_NAME    节点展示名（默认本机 hostname）
 *   LINKAGENT_NODE_ID      节点 id（缺省首次连接由网关签发并持久化，重连复用）
 *   LINKAGENT_NODE_AGENTS  逗号分隔的 agent id（缺省上报网关默认：opencode/pi/workbuddy/trace-cli/cursor）
 *   LINKAGENT_NODE_STATE_DIR 节点状态目录（默认 .runtime-state/node；本机多实例时各自指定可避免 nodeId 冲突）
 *   LINKAGENT_NODE_VERBOSE  设为 1 时输出 turn 文本预览，并开启 acpx verbose
 *
 * 两种运行场景（agent 来源不同）：
 *   - 本机节点（supervisor 托管，config.yaml node.enabled=true 经 pm start 拉起）：
 *     管理器会把 LINKAGENT_NODE_AGENTS 置空，只认共享 config 的 node.agents（缺省内置默认），环境变量不生效；
 *   - 独立节点（node:connect / node:start / node.env 启动）：
 *     环境变量优先，其次 config.node.agents，最后内置默认。
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
  /** 匿名申请时的 nu_ 归属申明码（hello.claimToken，非 Upgrade Bearer） */
  claimToken?: string;
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
  /** turn 文本预览 + acpx verbose（LINKAGENT_NODE_VERBOSE=1） */
  private readonly verbose = ['1', 'true', 'yes'].includes(
    (process.env.LINKAGENT_NODE_VERBOSE ?? '').trim().toLowerCase(),
  );
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
          ...(this.opts.claimToken ? { claimToken: this.opts.claimToken } : {}),
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
        if (!opened) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/\b401\b/.test(msg)) {
            reject(
              new Error(
                '网关返回 401：令牌不被目标网关接受。请使用该网关后台颁发的机器凭证（nt_）或它的静态 token；本机签发的 nt_ 不能拿到另一台网关上用。',
              ),
            );
            return;
          }
          reject(err);
        }
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
      const kind = resolveAcpKindForAgentId(agentId);
      const cmd = DEFAULT_COMMANDS[kind].join(' ');
      if (kind !== agentId.trim()) {
        console.warn(
          `[node] agentId "${agentId}" 未注册为 ACP 类型，启动命令回退 opencode（${DEFAULT_COMMANDS.opencode.join(' ')}）`,
        );
      } else {
        console.log(`[node] engine init agentId=${agentId} command=${cmd}`);
      }
      engine = new AcpEngine({
        id: agentId,
        agentName: kind,
        stateDir: join(this.opts.stateDir, 'acpx', agentId),
        verbose: this.verbose,
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
    const acpKind = resolveAcpKindForAgentId(msg.agentId);
    console.log(
      `[node] turn start requestId=${msg.requestId} agentId=${msg.agentId} acpKind=${acpKind} cwd=${msg.cwd ?? '-'} session=${msg.sessionKey ? 'persistent' : 'oneshot'} textLen=${msg.text.length}`,
    );
    if (this.verbose) {
      const preview = msg.text.length > 120 ? `${msg.text.slice(0, 120)}…` : msg.text;
      console.log(`[node] turn preview requestId=${msg.requestId}: ${JSON.stringify(preview)}`);
    }
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
      console.log(
        `[node] turn done requestId=${msg.requestId} agentId=${msg.agentId} status=${result.status}${result.error?.message ? ` error=${result.error.message}` : ''}`,
      );
      this.send({ type: 'turnResult', requestId: msg.requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[node] turn failed requestId=${msg.requestId} agentId=${msg.agentId} acpKind=${acpKind}: ${message}`);
      this.send({
        type: 'turnError',
        requestId: msg.requestId,
        message,
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

  // 读三进程共享配置的 node 段（env > 配置段 > gateway 段推导）
  const { config } = loadSharedConfig();
  const runtime = resolveChildRuntime(
    config,
    { gatewayUrl: config.node.gatewayUrl, gatewayToken: config.node.gatewayToken },
    { url: process.env.LINKAGENT_GATEWAY_URL, token: process.env.LINKAGENT_GATEWAY_TOKEN },
  );

  // supervisor 托管的本机节点会把 LINKAGENT_NODE_AGENTS 置空（空串走 falsy 分支），
  // 因此本机节点只走 config.node.agents / 内置默认，环境变量不生效；独立节点仍环境变量优先。
  const envAgents = process.env.LINKAGENT_NODE_AGENTS
    ? process.env.LINKAGENT_NODE_AGENTS.split(',')
        .map((s) => normalizeAgentId(s))
        .filter(Boolean)
    : null;
  const agents =
    envAgents ??
    (config.node.agents.length > 0
      ? config.node.agents.map((id) => normalizeAgentId(id))
      : defaultAgentDefinitions().map((d) => d.id));

  const rawToken = runtime.gatewayToken.trim();
  const token = rawToken || undefined;
  if (token) {
    if (isPersonalTokenShape(token)) {
      console.error(
        '[node] LINKAGENT_GATEWAY_TOKEN 是个人 API token（pat_），不能用于节点连接。请在后台「远程 · 节点」颁发 nt_ 机器凭证。',
      );
      process.exit(1);
    }
    if (token.startsWith(TASK_KEY_PREFIX)) {
      console.error(
        '[node] LINKAGENT_GATEWAY_TOKEN 是任务 key（k_），不能用于节点连接。请在后台「远程 · 节点」颁发 nt_ 机器凭证。',
      );
      process.exit(1);
    }
    if (isNodeClaimShape(token)) {
      console.error(
        '[node] LINKAGENT_GATEWAY_TOKEN 是归属申明码（nu_），不能用于 Upgrade。请改用 LINKAGENT_NODE_CLAIM，并删除 TOKEN 行走待审批。',
      );
      process.exit(1);
    }
    if (!isNodeTokenShape(token)) {
      console.warn(
        '[node] LINKAGENT_GATEWAY_TOKEN 不是 nt_ 机器凭证；若连接报 401，请确认未误用登录会话 token，并改用 nt_ 或网关静态 token。',
      );
    }
  }
  const claimToken = process.env.LINKAGENT_NODE_CLAIM?.trim() || undefined;
  const connector = new NodeConnector({
    gatewayUrl: args.gatewayUrl ?? runtime.gatewayUrl,
    ...(token ? { token } : {}),
    ...(claimToken ? { claimToken } : {}),
    name:
      args.name ??
      process.env.LINKAGENT_NODE_NAME ??
      (config.node.name || `node-${hostname()}`),
    nodeId: envNodeId || loadPersistedNodeId(stateDir),
    // 配置了网关令牌时无需 secret；否则读取审批模式持久化的节点凭证
    ...(token ? {} : { secret: loadPersistedSecret(stateDir) }),
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
