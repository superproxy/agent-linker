import type { AgentAdapter, AgentDescriptor, ChatRequest, ChatResult, StreamCallbacks } from '@linkagent/shared';
import { lastUserText } from '@linkagent/shared/opencode';
import { NodeOfflineError, type NodeLink } from '../nodes/link.js';

/**
 * 远程节点 agent 适配器：实现 AgentAdapter，把一轮对话经 NodeLink（WebSocket）
 * 派发到节点机，由节点侧 AcpEngine 在本机拉起 ACP agent。
 * 每个在线节点的每个自报 agent 对应一个实例；节点离线时 chat 直接抛 NodeOfflineError。
 */
export class RemoteNodeAdapter implements AgentAdapter {
  readonly id: string;
  readonly nodeId: string;
  private readonly link: NodeLink;
  private readonly displayName: string;
  private readonly description: string;

  constructor(nodeId: string, agentId: string, link: NodeLink, displayName?: string, description?: string) {
    this.nodeId = nodeId;
    this.id = agentId;
    this.link = link;
    this.displayName = displayName || agentId;
    this.description = description || `远程节点 ${nodeId} 上的 ${agentId}`;
  }

  descriptor(): AgentDescriptor {
    return { id: this.id, displayName: this.displayName, description: this.description };
  }

  async chat(req: ChatRequest, cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    if (!this.link.online) throw new NodeOfflineError(this.nodeId);
    const text = lastUserText(req.messages) ?? '';
    if (!text) throw new Error('请求中没有可发送的 user 文本（网关一期仅支持文本）');
    const result = await this.link.runTurn(
      {
        agentId: this.id,
        text,
        ...(req.sessionKey?.trim() ? { sessionKey: req.sessionKey.trim() } : {}),
        ...(req.cwd?.trim() ? { cwd: req.cwd } : {}),
        ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      },
      (ev) => {
        if (ev.kind === 'text') cb.onText(ev.text);
        else if (ev.kind === 'thought') cb.onReasoning?.(ev.text);
        else cb.onToolActivity?.(ev.name);
      },
      signal,
    );
    if (result.status === 'failed') throw new Error(result.error?.message ?? '远程 agent 执行失败');
    if (result.sessionId) cb.onSessionId?.(result.sessionId);
    return { sessionId: result.sessionId };
  }

  async dispose(): Promise<void> {
    // 连接生命周期由 NodeManager 管理，这里无资源需释放
  }
}
