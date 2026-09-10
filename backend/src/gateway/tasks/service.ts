import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_TASK_ID,
  DEFAULT_TASK_NAME,
  KNOWN_AGENT_IDS,
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

  /**
   * 解析 /task 命令并就地变更状态。
   * 非命令返回 null；命令返回回复文本（纯文本，bot 原样展示）。
   * 命令表：new / list / use <id> / del <id> / rename <id> <名> / help
   */
  handleCommand(state: UserTasks, text: string): CommandResult | null {
    const line = text.trim();
    if (!isTaskCommand(line)) return null;
    const parts = line.slice(TASK_COMMAND_PREFIX.length).trim().split(/\s+/).filter(Boolean);
    const cmd = (parts[0] ?? 'help').toLowerCase();
    const known = [...KNOWN_AGENT_IDS, this.defaultAgentId];

    switch (cmd) {
      case 'new': {
        // /task new <名称...> [agent]
        const rest = parts.slice(1);
        let name = rest.join(' ');
        let agentId: string | undefined;
        if (rest.length >= 2 && known.includes(rest[rest.length - 1].toLowerCase())) {
          agentId = rest[rest.length - 1].toLowerCase();
          name = rest.slice(0, -1).join(' ');
        }
        const task = this.createTask(state, name, agentId);
        return {
          text: `✅ 已新建任务 [${task.name}] → ${task.agentId}（已激活）`,
          activeTaskId: task.id,
          activeAgentId: task.agentId,
        };
      }
      case 'list': {
        const lines = state.tasks.map((t, i) => {
          const mark = t.id === state.activeTaskId ? ' ← 激活' : '';
          return `[${i + 1}] ${t.name} → ${t.agentId}${mark}`;
        });
        return { text: `📋 任务列表（${state.tasks.length}）：\n${lines.join('\n')}` };
      }
      case 'use': {
        const id = parts[1];
        if (!id) return { text: '用法：/task use <任务id>' };
        try {
          const task = this.activateTask(state, id);
          return {
            text: `🔀 已切换到 [${task.name}] → ${task.agentId}`,
            activeTaskId: task.id,
            activeAgentId: task.agentId,
          };
        } catch (err) {
          return { text: `❌ ${err instanceof Error ? err.message : err}` };
        }
      }
      case 'del': {
        const id = parts[1];
        if (!id) return { text: '用法：/task del <任务id>' };
        try {
          this.deleteTask(state, id);
          const active = state.tasks.find((t) => t.id === state.activeTaskId);
          return {
            text: `🗑 已删除任务 ${id}（当前激活：${active?.name ?? '无'}）`,
            activeTaskId: state.activeTaskId,
            activeAgentId: active?.agentId,
          };
        } catch (err) {
          return { text: `❌ ${err instanceof Error ? err.message : err}` };
        }
      }
      case 'rename': {
        const id = parts[1];
        const name = parts.slice(2).join(' ');
        if (!id || !name) return { text: '用法：/task rename <任务id> <新名称>' };
        try {
          const task = this.renameTask(state, id, name);
          return { text: `✏️ 已重命名 → [${task.name}]` };
        } catch (err) {
          return { text: `❌ ${err instanceof Error ? err.message : err}` };
        }
      }
      case 'help':
        return {
          text: [
            '📌 任务命令：',
            '/task new <名称> [agent]  新建任务（agent: pi/opencode）',
            '/task list               查看全部任务',
            '/task use <id>           切换到指定任务',
            '/task del <id>           删除任务',
            '/task rename <id> <名>   重命名',
            '普通消息自动进入「激活任务」对应的 agent。',
          ].join('\n'),
        };
      default:
        return { text: `❌ 未知命令 /task ${cmd}（/task help 查看用法）` };
    }
  }
}
