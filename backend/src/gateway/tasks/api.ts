import type { FastifyInstance } from 'fastify';
import { isTaskCommand, type TaskService } from './service.js';
import { DEFAULT_TASK_ID } from './types.js';

export type AuthCheck = (request: { headers: Record<string, string | string[] | undefined> }) => boolean;

/** 挂载 /api/tasks（鉴权与现有 /api/* 一致：checkAuth 闭包传入） */
export function registerTaskApi(app: FastifyInstance, service: TaskService, checkAuth: AuthCheck): void {
  const requireAuth = (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code(code: number): unknown },
  ): boolean => {
    if (checkAuth(request)) return true;
    reply.code(401);
    return false;
  };

  // GET /api/tasks?channel=&userId=
  app.get('/api/tasks', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const channel = (request.query as { channel?: string }).channel ?? '';
    const userId = (request.query as { userId?: string }).userId ?? '';
    if (!channel || !userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    return service.load(channel, userId);
  });

  // POST /api/tasks { channel, userId, name, agentId? }
  app.post('/api/tasks', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const body = request.body as { channel?: string; userId?: string; name?: string; agentId?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    const state = service.load(body.channel, body.userId);
    const task = service.createTask(state, body.name ?? '', body.agentId);
    return task;
  });

  // PATCH /api/tasks/:taskId/activate { channel, userId }
  app.patch('/api/tasks/:taskId/activate', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { taskId: string };
    const body = request.body as { channel?: string; userId?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    const state = service.load(body.channel, body.userId);
    try {
      const task = service.activateTask(state, params.taskId);
      return { task };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/tasks/:taskId?channel=&userId=
  app.delete('/api/tasks/:taskId', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { taskId: string };
    const query = request.query as { channel?: string; userId?: string };
    if (!query.channel || !query.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    if (params.taskId === DEFAULT_TASK_ID) return reply.code(400).send({ error: '默认任务不可删除' });
    const state = service.load(query.channel, query.userId);
    try {
      const tasks = service.deleteTask(state, params.taskId);
      return { tasks, activeTaskId: state.activeTaskId };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

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
