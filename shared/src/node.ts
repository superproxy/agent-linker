/**
 * 远程节点（node）：其他机器运行 node 连接器，经 WebSocket 连入网关并在本机拉起 ACP agent。
 * 任务绑定 nodeId + agentId，始终在同一台机器执行；持久会话与 cwd 都落在该节点。
 * 本文件定义网关↔节点之间的 WS 消息协议与 REST 展示类型（单一事实来源，前后端共用）。
 */

/** 内建本机节点 id：网关自身永远在线，advertise config 里的 agents；存量无 nodeId 任务归一化到它 */
export const LOCAL_NODE_ID = 'local';
export const LOCAL_NODE_NAME = '本机（网关）';

/** 节点自报的可运行 agent（id = ACP kind/逻辑 id，如 pi/opencode） */
export interface NodeAgentInfo {
  id: string;
  displayName?: string;
}

/** 节点准入状态：approved=已批准可路由；pending=等待管理员审批；blocked=已拒绝（持静态令牌仍可直连上线） */
export type NodeAdmissionStatus = 'approved' | 'pending' | 'blocked';

/** 节点 REST 展示（GET /api/nodes） */
export interface NodeInfo {
  nodeId: string;
  name: string;
  online: boolean;
  agents: NodeAgentInfo[];
  version?: string;
  /** 准入状态；存量记录（无状态字段）按 approved 处理 */
  status?: NodeAdmissionStatus;
  /** 本次连接建立时间（ms） */
  connectedAt?: number;
  /** 最近一次心跳/消息时间（ms） */
  lastSeenAt?: number;
  remoteAddress?: string;
  /** 用户颁发机器 token 接入时的属主登录名；网关 token / 匿名审批接入可为空 */
  ownerUsername?: string;
  /**
   * 是否被管理员临时停用：true 时不参与路由（resolveForRouting 走 'offline'），重连时被关
   * ——独立于 status（准入），用于"暂不可用、可恢复"语义
   */
  disabled?: boolean;
}

/**
 * 按机器（节点）聚合的 agent 开通视图（GET /api/agents/by-node）。
 * agent 是「每台机器各自开通」的：本机由网关配置（可编辑），远程机器由其连接器自报（只读）。
 */

/** 本机（网关内建 local 节点）上一个 agent 的可编辑运行态 */
export interface LocalAgentView {
  id: string;
  type: string;
  displayName: string;
  description: string;
  /** 当前生效的会话模型（undefined=agent 自身默认） */
  model?: string;
  /** 运行时是否启用 */
  enabled: boolean;
}

/** 远程机器上一个自报开通的 agent（只读） */
export interface RemoteAgentView {
  id: string;
  displayName?: string;
}

/** 本机分组：agent 来自 gateway.agents 配置，可在后台启停/切模型/设默认 */
export interface LocalNodeAgentView {
  nodeId: typeof LOCAL_NODE_ID;
  name: string;
  online: true;
  status: 'approved';
  agents: LocalAgentView[];
}

/** 远程机器分组：agent 由该机器连接器自报，网关侧只读 */
export interface RemoteNodeAgentView {
  nodeId: string;
  name: string;
  online: boolean;
  status?: NodeAdmissionStatus;
  agents: RemoteAgentView[];
  version?: string;
  connectedAt?: number;
  lastSeenAt?: number;
  remoteAddress?: string;
  ownerUsername?: string;
}

export interface AgentsByNode {
  /** 全局新任务默认绑定的本机 agentId（config.yaml tasks.defaultAgentId） */
  defaultAgentId: string;
  local: LocalNodeAgentView;
  nodes: RemoteNodeAgentView[];
}

/** 节点归一化后的流式事件（与传输无关，远程侧把 acpx 事件收敛成这三类） */
export type NodeTurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; name: string };

export interface NodeTurnResult {
  status: 'completed' | 'failed';
  error?: { message?: string };
  sessionId?: string;
}

// ── WebSocket 消息（JSON 文本帧）──

/** 节点 → 网关 */
export type NodeToGateway =
  /**
   * 握手：
   *   token  = 网关静态令牌（auth.token），正确即直连上线（令牌直连模式）
   *   secret = 网关此前为该 nodeId 签发的节点凭证（审批通过/待审批重连时携带）
   * 两者皆空且网关开启鉴权 → 进入待审批；token 错误 → 拒绝
   */
  | { type: 'hello'; token?: string; secret?: string; nodeId?: string; name: string; version?: string; agents: NodeAgentInfo[] }
  | { type: 'pong' }
  | { type: 'turnEvent'; requestId: string; event: NodeTurnEvent }
  | { type: 'turnResult'; requestId: string; result: NodeTurnResult }
  | { type: 'turnError'; requestId: string; message: string };

/** 网关 → 节点 */
export type GatewayToNode =
  /**
   * welcome：握手结果。
   *   approved=true  已准入，后续可收 turn；首次申请且自动批准时会下发 secret
   *   approved=false 已进入待审批，节点应保活等待，不要重连刷屏；secret 为其重连凭证
   */
  | { type: 'welcome'; nodeId: string; approved: boolean; secret?: string }
  /** 管理员在后台批准了此前待审批的节点：节点即刻可用，应持久化 secret */
  | { type: 'approved'; secret: string }
  /** 管理员拒绝：节点应停止重连，等待人工处理 */
  | { type: 'rejected'; reason?: string }
  | { type: 'ping' }
  | {
      type: 'turn';
      requestId: string;
      agentId: string;
      /** 会话模型（经 ACP set_config_option 下发） */
      model?: string;
      /** 会话工作目录（任务级 cwd，落在节点机） */
      cwd?: string;
      /** 持久会话 key：相同 key 在节点侧复用同一 agent 会话；缺省为一次性会话 */
      sessionKey?: string;
      text: string;
      permissionMode?: 'approve-all' | 'approve-reads' | 'deny-all';
    }
  | { type: 'cancel'; requestId: string }
  | { type: 'closeSession'; sessionKey: string };
