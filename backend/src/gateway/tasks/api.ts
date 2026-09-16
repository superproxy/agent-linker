import type { FastifyInstance } from 'fastify';
import { isTaskCommand, type TaskService } from './service.js';
import { DEFAULT_TASK_ID, type TaskItem } from './types.js';

/**
 * 支持任务机制的渠道白名单。
 * 活动任务只存在于微信渠道（weixin-bot 多轮会话）与 dev 控制台对话框
 * （console 以微信用户身份 channel=weixin 发起请求，天然覆盖）；
 * 企业微信 wecom 等其它渠道无任务：消息按原 model+sessionKey 路由，
 * 任务 API 对其返回 400，从源头保证不会产生任务状态。
 */
const TASK_ROUTING_CHANNELS = new Set(['weixin']);

/** 渠道是否允许任务机制；不允许时写 400 并返回 false */
function ensureTaskChannel(channel: string, reply: { code(code: number): unknown }): boolean {
  if (TASK_ROUTING_CHANNELS.has(channel)) return true;
  reply.code(400);
  return false;
}

export type AuthCheck = (request: { headers: Record<string, string | string[] | undefined> }) => boolean;

/** 任务管理接口的可选外部依赖（默认 agent 的可用性校验与 gateway.yaml 持久化） */
export interface TaskApiDeps {
  /** 当前可用 agent id 列表（配置/已启用）；提供后设置默认 agent 时校验存在性 */
  listAvailableAgents?: () => string[];
  /** 把默认 agent 持久化到 gateway.yaml；缺省仅内存生效（重启还原配置文件值） */
  persistDefaultAgent?: (agentId: string) => void | Promise<void>;
}

/** 挂载 /api/tasks（鉴权与现有 /api/* 一致：checkAuth 闭包传入） */
export function registerTaskApi(
  app: FastifyInstance,
  service: TaskService,
  checkAuth: AuthCheck,
  deps: TaskApiDeps = {},
): void {
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
    if (!ensureTaskChannel(channel, reply)) return { error: `渠道 ${channel} 不支持任务机制（活动任务仅微信渠道）` };
    return service.load(channel, userId);
  });

  // GET /api/tasks/by-key/:key —— 任务 key 反查（管理后台/外部分享直连用，返回任务与归属用户）
  app.get('/api/tasks/by-key/:key', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const { key } = request.params as { key: string };
    const ref = service.findByKey(key);
    if (!ref) return reply.code(404).send({ error: `任务不存在: ${key}` });
    return { channel: ref.channel, userId: ref.userId, task: ref.task };
  });

  // GET /api/tasks/all —— 全部用户的任务明细（管理后台「任务」页）
  app.get('/api/tasks/all', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    // 开箱状态（尚无渠道消息落盘）也展示系统默认用户（weixin/default）的默认任务
    service.ensureSystemDefault();
    return { users: service.listAllTasks() };
  });

  // GET /api/users —— 全部用户（含任务数），用户列表页
  app.get('/api/users', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    service.ensureSystemDefault();
    return { users: service.listUsers() };
  });

  // GET /api/tasks/default-agent —— 全局默认任务绑定的 agentId（新建用户默认任务的初始绑定）
  app.get('/api/tasks/default-agent', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    return { defaultAgentId: service.getDefaultAgentId() };
  });

  // PUT /api/tasks/default-agent { agentId } —— 修改全局默认 agent，持久化到 gateway.yaml（重启保留）
  app.put('/api/tasks/default-agent', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const body = request.body as { agentId?: string } | null | undefined;
    const agentId = body?.agentId?.trim().toLowerCase();
    if (!agentId) return reply.code(400).send({ error: 'agentId 必填' });
    if (deps.listAvailableAgents) {
      const available = deps.listAvailableAgents();
      if (!available.includes(agentId)) {
        return reply.code(400).send({ error: `Agent 不存在: ${agentId}（可用：${available.join('/') || '无'}）` });
      }
    }
    const previous = service.getDefaultAgentId();
    service.setDefaultAgentId(agentId);
    if (deps.persistDefaultAgent) {
      try {
        await deps.persistDefaultAgent(agentId);
      } catch (err) {
        // 持久化失败：回滚内存值，保证「返回成功即已落盘」的一致性
        service.setDefaultAgentId(previous);
        return reply.code(500).send({ error: `持久化到 gateway.yaml 失败：${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { defaultAgentId: service.getDefaultAgentId() };
  });

  // DELETE /api/users/:channel/:userId —— 删除用户全部状态（任务随用户一起删）
  app.delete('/api/users/:channel/:userId', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { channel: string; userId: string };
    if (!params.channel || !params.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    service.deleteUser(params.channel, params.userId);
    return { ok: true };
  });

  // POST /api/tasks { channel, userId, name, agentId?, key? } —— key 可选自定义（缺省自动生成）
  app.post('/api/tasks', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const body = request.body as { channel?: string; userId?: string; name?: string; agentId?: string; key?: string; cwd?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    if (!ensureTaskChannel(body.channel, reply)) return { error: `渠道 ${body.channel} 不支持任务机制（活动任务仅微信渠道）` };
    const state = service.load(body.channel, body.userId);
    try {
      const task = service.createTask(state, body.name ?? '', body.agentId, body.key, body.cwd);
      return task;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/tasks/:taskId { channel, userId, name?, keyEnabled?, cwd? } —— 重命名 / 停用启用任务 key / 设置工作目录
  app.patch('/api/tasks/:taskId', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { taskId: string };
    const body = request.body as { channel?: string; userId?: string; name?: string; keyEnabled?: boolean; cwd?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    if (!ensureTaskChannel(body.channel, reply)) return { error: `渠道 ${body.channel} 不支持任务机制（活动任务仅微信渠道）` };
    if (!body.name?.trim() && typeof body.keyEnabled !== 'boolean' && !('cwd' in (body ?? {}))) {
      return reply.code(400).send({ error: 'name / keyEnabled / cwd 至少提供一个' });
    }
    const state = service.load(body.channel, body.userId);
    try {
      let task: TaskItem | undefined;
      if (typeof body.keyEnabled === 'boolean') {
        task = service.setKeyEnabled(state, params.taskId, body.keyEnabled);
      }
      if (body.name?.trim()) {
        task = service.renameTask(state, params.taskId, body.name);
      }
      if ('cwd' in (body ?? {})) {
        task = service.setTaskCwd(state, params.taskId, body.cwd);
      }
      return { task };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/tasks/:taskId/agent { channel, userId, agentId } —— 修改任务绑定 agent
  app.patch('/api/tasks/:taskId/agent', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { taskId: string };
    const body = request.body as { channel?: string; userId?: string; agentId?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    if (!ensureTaskChannel(body.channel, reply)) return { error: `渠道 ${body.channel} 不支持任务机制（活动任务仅微信渠道）` };
    if (!body?.agentId?.trim()) return reply.code(400).send({ error: 'agentId 必填' });
    const agentId = body.agentId.trim().toLowerCase();
    if (deps.listAvailableAgents) {
      const available = deps.listAvailableAgents();
      if (!available.includes(agentId)) {
        return reply.code(400).send({ error: `Agent 不存在: ${agentId}（可用：${available.join('/') || '无'}）` });
      }
    }
    const state = service.load(body.channel, body.userId);
    try {
      const task = service.setTaskAgent(state, params.taskId, agentId);
      return { task };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/tasks/:taskId/activate { channel, userId }
  app.patch('/api/tasks/:taskId/activate', async (request, reply) => {
    if (!requireAuth(request, reply)) return { error: 'unauthorized' };
    const params = request.params as { taskId: string };
    const body = request.body as { channel?: string; userId?: string };
    if (!body?.channel || !body?.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    if (!ensureTaskChannel(body.channel, reply)) return { error: `渠道 ${body.channel} 不支持任务机制（活动任务仅微信渠道）` };
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
    if (!ensureTaskChannel(query.channel, reply)) return { error: `渠道 ${query.channel} 不支持任务机制（活动任务仅微信渠道）` };
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

/** /v1 请求里的任务路由入参（channel/userId/agent/task/taskKey 均为 linkagent 扩展字段） */
export interface TaskRoutingInput {
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  /** 任务全局 key：单独用它即可直连路由到目标任务（无需 channel/userId/task 三元素） */
  taskKey?: string;
  /**
   * OpenAI 标准 model 参数（agent:<id> 形式）：
   * - taskKey 直连分支可用于覆盖任务绑定 agent（保留通用客户端显式指定能力）；
   * - 三元素路由（微信渠道）不参与：agent 只由任务绑定/显式 agent 字段决定，
   *   避免 weixin.model 写死值（如 agent:pi）与 tasks.defaultAgentId 不一致时
   *   把 default 任务误路由到写死的 agent。
   */
  model?: string;
  text: string;
}

/** 从 model 参数（agent:xxx）解析 agent id；非 agent: 前缀返回空串 */
function agentFromModel(model?: string): string {
  const m = model?.trim() ?? '';
  return m.startsWith('agent:') ? m.slice('agent:'.length) : '';
}

export type TaskRoutingDecision =
  | { kind: 'legacy' } // 无 taskKey/channel/userId，或渠道不在任务白名单（wecom 等）：走原 model+sessionKey
  | { kind: 'notfound' } // taskKey 全局反查失败（任务不存在/已被删除）
  | { kind: 'disabled' } // taskKey 存在但已被管理后台停用（吊销直连，任务本体不受影响）
  | { kind: 'command'; text: string; activeTaskId?: string; activeAgentId?: string }
  | { kind: 'chat'; agentId: string; taskId: string; sessionKey: string; cwd?: string };

/**
 * /v1/chat/completions 的任务路由决策（handler 内一个分支，无独立拦截层）：
 * - 带 taskKey → 全局反查到 {channel,userId,task} 后按该任务路由（单 key 直连，无需三元素）；
 *   任务 key 已被停用 → disabled（鉴权拒绝，任务本体不受影响）；
 * - 无 taskKey 但 channel 在白名单（仅 weixin：微信渠道 + 控制台对话框）→ 三元素路由；
 *   userId 缺省时视为 default 用户（不写 user 就是 default）；
 * - channel 不存在 → legacy（原 model+sessionKey 路径）；
 * - /task 命令 → 本地解析，返回文本（不走 agent）；
 * - 普通消息 → 激活任务绑定 agent（可被显式 agent 覆盖；微信渠道 model 不参与，
 *   model 仅 taskKey 直连分支可用）→ 派生 agentId + sessionKey。
 */
export function decideTaskRouting(service: TaskService, input: TaskRoutingInput): TaskRoutingDecision {
  const taskKey = input.taskKey?.trim() ?? '';
  const channel = input.channel?.trim() ?? '';
  // 不写 user 就是 default 用户
  const userId = input.userId?.trim() || 'default';

  // taskKey 单 key 直连路由：全局反查任务，channel/userId 由 key 决定
  if (taskKey) {
    const ref = service.findByKey(taskKey);
    if (!ref) return { kind: 'notfound' };
    if (ref.task.keyEnabled === false) return { kind: 'disabled' };
    const state = service.load(ref.channel, ref.userId);
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
    const route = service.resolveRoute(state, ref.task.id);
    const agentId = input.agent?.trim() || agentFromModel(input.model) || route.agentId;
    return {
      kind: 'chat',
      agentId,
      taskId: route.taskId,
      sessionKey: `${ref.channel}:${ref.userId}:task:${route.taskId}`,
      cwd: route.cwd,
    };
  }

  // 无 taskKey、无 channel，或渠道不在任务白名单（wecom 等无任务机制）→ 原 model+sessionKey 路径
  if (!channel || !TASK_ROUTING_CHANNELS.has(channel)) return { kind: 'legacy' };
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
  // 微信渠道（三元素路由）：agent 只由「任务」决定 —— 激活任务绑定的 agent，
  // 或 input.agent 显式覆盖；model（weixin.model 写死 agent:pi）不参与，
  // 保证 default 任务权威绑定 tasks.defaultAgentId，避免配置分叉时误路由。
  const agentId = input.agent?.trim() || route.agentId;
  return {
    kind: 'chat',
    agentId,
    taskId: route.taskId,
    sessionKey: `${channel}:${userId}:task:${route.taskId}`,
    cwd: route.cwd,
  };
}
