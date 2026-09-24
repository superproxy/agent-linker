import type { AcpPermissionMode, NodeTurnEvent, NodeTurnResult, PermissionPolicySpec } from '@linkagent/shared';

/** 网关侧发给某个在线节点的一轮对话请求（编码为 WS turn 消息） */
export interface RemoteTurnRequest {
  agentId: string;
  model?: string;
  cwd?: string;
  /** 持久会话 key（渠道多轮）；缺省一次性会话 */
  sessionKey?: string;
  text: string;
  permissionMode?: AcpPermissionMode;
  permissionPolicy?: PermissionPolicySpec;
}

/**
 * 到某个在线节点的会话链路（由 NodeManager 提供给 RemoteNodeAdapter）。
 * 与传输解耦：runTurn 把请求发出去，事件经 onEvent 流式回调，最终收敛为 NodeTurnResult。
 */
export interface NodeLink {
  readonly nodeId: string;
  online: boolean;
  runTurn(req: RemoteTurnRequest, onEvent: (ev: NodeTurnEvent) => void, signal?: AbortSignal): Promise<NodeTurnResult>;
}

/** 节点离线 / 会话不可用错误（路由层据此返回 node_offline） */
export class NodeOfflineError extends Error {
  code = 'node_offline';
  constructor(nodeId: string) {
    super(`节点离线，任务暂不可用：${nodeId}`);
    this.name = 'NodeOfflineError';
  }
}
