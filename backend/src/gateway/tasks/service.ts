import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_TASK_ID,
  DEFAULT_TASK_NAME,
  TASK_COMMAND_PREFIX,
  type CommandResult,
  type TaskItem,
  type TaskRoute,
  type UserTasks,
} from './types.js';

export interface TaskServiceOptions {
  store: TaskStore;
  /** 默认任务绑定的 agent（gateway.yaml tasks.defaultAgentId，缺省 opencode） */
  defaultAgentId?: string;
}

/** 短随机任务 id：t_<8 hex> */
export function newTaskId(): string {
  return `t_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export function isTaskCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === TASK_COMMAND_PREFIX || t.startsWith(`${TASK_COMMAND_PREFIX} `);
}

export class TaskService {
  private readonly store: TaskStore;
  private readonly defaultAgentId: string;

  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.defaultAgentId = options.defaultAgentId ?? DEFAULT_AGENT_ID;
  }

  /** 读用户状态；不存在则预置 default 任务并落盘（开箱可聊） */
  load(channel: string, userId: string): UserTasks {
    const existing = this.store.read(channel, userId);
    if (existing) return existing;
    const fresh: UserTasks = {
      channel,
      userId,
      activeTaskId: DEFAULT_TASK_ID,
      tasks: [
        { id: DEFAULT_TASK_ID, name: DEFAULT_TASK_NAME, agentId: this.defaultAgentId, createdAt: Date.now() },
      ],
    };
    this.store.write(fresh);
    return fresh;
  }

  createTask(state: UserTasks, name: string, agentId?: string): TaskItem {
    const task: TaskItem = {
      id: newTaskId(),
      name: name.trim() || `任务 ${state.tasks.length + 1}`,
      agentId: agentId?.trim() || this.agentOf(state),
      createdAt: Date.now(),
    };
    state.tasks.push(task);
    state.activeTaskId = task.id; // 新建即激活
    this.store.write(state);
    return task;
  }

  listTasks(state: UserTasks): TaskItem[] {
    return state.tasks;
  }

  activateTask(state: UserTasks, id: string): TaskItem {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    state.activeTaskId = task.id;
    this.store.write(state);
    return task;
  }

  deleteTask(state: UserTasks, id: string): TaskItem[] {
    if (id === DEFAULT_TASK_ID) throw new Error('默认任务不可删除');
    const idx = state.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`任务不存在: ${id}`);
    state.tasks.splice(idx, 1);
    if (state.activeTaskId === id) {
      state.activeTaskId = state.tasks[0]?.id ?? DEFAULT_TASK_ID;
      if (state.activeTaskId === DEFAULT_TASK_ID && !state.tasks.some((t) => t.id === DEFAULT_TASK_ID)) {
        state.tasks.unshift({
          id: DEFAULT_TASK_ID,
          name: DEFAULT_TASK_NAME,
          agentId: this.defaultAgentId,
          createdAt: Date.now(),
        });
      }
    }
    this.store.write(state);
    return state.tasks;
  }

  renameTask(state: UserTasks, id: string, name: string): TaskItem {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    task.name = name.trim() || task.name;
    this.store.write(state);
    return task;
  }

  /** 普通消息路由：taskId 缺省用激活任务；任务缺失回落到列表第一个 */
  resolveRoute(state: UserTasks, taskId?: string): TaskRoute {
    const id = taskId?.trim() || state.activeTaskId || DEFAULT_TASK_ID;
    const task = state.tasks.find((t) => t.id === id) ?? state.tasks[0];
    return { agentId: task.agentId, taskId: task.id, taskName: task.name };
  }

  /** 当前激活任务的 agent（新建任务缺省继承） */
  private agentOf(state: UserTasks): string {
    const active = state.tasks.find((t) => t.id === state.activeTaskId);
    return active?.agentId ?? this.defaultAgentId;
  }
}
