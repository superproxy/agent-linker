import { isTaskCommand, type TaskService } from './service.js';

/** /v1 请求里的任务路由入参（channel/userId/agent/task 均为 linkagent 扩展字段） */
export interface TaskRoutingInput {
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  text: string;
}

export type TaskRoutingDecision =
  | { kind: 'legacy' } // 无 channel/userId：走原 model+sessionKey
  | { kind: 'command'; text: string; activeTaskId?: string; activeAgentId?: string }
  | { kind: 'chat'; agentId: string; taskId: string; sessionKey: string };

/**
 * /v1/chat/completions 的任务路由决策（handler 内一个分支，无独立拦截层）：
 * - 无 channel/userId → legacy；
 * - /task 命令 → 本地解析，返回文本（不走 agent）；
 * - 普通消息 → 激活任务（可被显式 agent/task 覆盖）→ 派生 agentId + sessionKey。
 */
export function decideTaskRouting(service: TaskService, input: TaskRoutingInput): TaskRoutingDecision {
  const channel = input.channel?.trim() ?? '';
  const userId = input.userId?.trim() ?? '';
  if (!channel || !userId) return { kind: 'legacy' };
  const state = service.load(channel, userId);
  if (isTaskCommand(input.text)) {
    const result = service.handleCommand(state, input.text);
    if (!result) return { kind: 'legacy' }; // 防御：理论不可达
    return {
      kind: 'command',
      text: result.text,
      activeTaskId: result.activeTaskId,
      activeAgentId: result.activeAgentId,
    };
  }
  const route = service.resolveRoute(state, input.task);
  const agentId = input.agent?.trim() || route.agentId;
  return {
    kind: 'chat',
    agentId,
    taskId: route.taskId,
    sessionKey: `${channel}:${userId}:task:${route.taskId}`,
  };
}
