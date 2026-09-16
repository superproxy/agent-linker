import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskStore } from './store.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_TASK_ID,
  DEFAULT_TASK_NAME,
  KNOWN_AGENT_IDS,
  TASK_COMMAND_PREFIX,
  TASK_KEY_PREFIX,
  type CommandResult,
  type TaskItem,
  type TaskRoute,
  type UserTasks,
} from './types.js';

/** 任务机制的系统渠道（与任务路由白名单一致，目前仅微信渠道） */
export const SYSTEM_TASK_CHANNEL = 'weixin';
/** 系统默认用户：三元素路由 userId 缺省时即该用户（不写 user 就是 default） */
export const SYSTEM_DEFAULT_USER = 'default';

export interface TaskServiceOptions {
  store: TaskStore;
  /** 默认任务绑定的 agent（gateway.yaml tasks.defaultAgentId，缺省 opencode） */
  defaultAgentId?: string;
  /**
   * 任务工作空间根目录（gateway.yaml tasks.workspaceDir）。
   * 配置后每个任务默认拥有独立工作目录 <root>/<userId>/<taskId>（显式 cwd 优先），任务间文件系统隔离；
   * 不配置则不自动分配（任务回落到 agent 默认工作目录）。
   */
  workspaceRoot?: string;
}

/** 短随机任务 id：t_<8 hex> */
export function newTaskId(): string {
  return `t_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** 全局唯一任务 key：k_<12 hex>（跨用户反查/直连路由用） */
export function newTaskKey(): string {
  return `${TASK_KEY_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function isTaskCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === TASK_COMMAND_PREFIX || t.startsWith(`${TASK_COMMAND_PREFIX} `);
}

export class TaskService {
  private readonly store: TaskStore;
  /** 默认任务绑定的 agent：构造时取 gateway.yaml tasks.defaultAgentId，可经管理后台运行时修改并持久化 */
  private defaultAgentId: string;
  private readonly workspaceRoot?: string;

  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.defaultAgentId = options.defaultAgentId ?? DEFAULT_AGENT_ID;
    this.workspaceRoot = options.workspaceRoot?.trim() || undefined;
  }

  /** 任务独立工作目录 <root>/<userId>/<taskId>（自动创建）；未配 workspaceRoot 返回 undefined */
  private taskWorkspaceDir(userId: string, taskId: string): string | undefined {
    if (!this.workspaceRoot) return undefined;
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
    const dir = join(this.workspaceRoot, safe(userId), taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 确保系统默认用户（weixin/default：三元素路由 userId 缺省即该用户）的默认任务已建档。
   * 管理后台「任务管理 / 用户管理」页首次打开（尚无任何渠道消息落盘）时调用，
   * 让开箱状态也能看到并管理系统默认任务；已有建档则为纯读取、无副作用。
   */
  ensureSystemDefault(): UserTasks {
    return this.load(SYSTEM_TASK_CHANNEL, SYSTEM_DEFAULT_USER);
  }

  /** 全局默认任务绑定的 agentId（gateway.yaml tasks.defaultAgentId 的运行时值） */
  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }

  /**
   * 更新全局默认 agentId（仅影响之后新建用户的默认任务、删除后重建的默认任务与路由兜底）。
   * 已存在用户的默认任务是各自的独立快照，不在此批量改写（如需改单个实例，用任务的 setTaskAgent）。
   * 持久化到 gateway.yaml 由调用方（管理接口）负责，保证内存与文件一致失败时可回滚。
   */
  setDefaultAgentId(agentId: string): string {
    const id = agentId.trim().toLowerCase();
    if (!id) throw new Error('agentId 必填');
    this.defaultAgentId = id;
    return this.defaultAgentId;
  }

  /** 读用户状态；不存在则预置 default 任务并落盘（开箱可聊） */
  load(channel: string, userId: string): UserTasks {
    const existing = this.store.read(channel, userId);
    if (existing) return this.ensureKeys(existing);
    const workspace = this.taskWorkspaceDir(userId, DEFAULT_TASK_ID);
    const fresh: UserTasks = {
      channel,
      userId,
      activeTaskId: DEFAULT_TASK_ID,
      tasks: [
        {
          id: DEFAULT_TASK_ID,
          key: newTaskKey(),
          keyEnabled: true,
          name: DEFAULT_TASK_NAME,
          agentId: this.defaultAgentId,
          ...(workspace ? { cwd: workspace } : {}),
          createdAt: Date.now(),
        },
      ],
    };
    this.store.write(fresh);
    return fresh;
  }

  /** 旧数据（无 key / keyEnabled / cwd 字段）惰性补齐；有变更才落盘（幂等） */
  private ensureKeys(state: UserTasks): UserTasks {
    let changed = false;
    for (const t of state.tasks) {
      if (!t.key) {
        t.key = newTaskKey();
        changed = true;
      }
      if (t.keyEnabled === undefined) {
        t.keyEnabled = true;
        changed = true;
      }
      if (!t.cwd && this.workspaceRoot) {
        t.cwd = this.taskWorkspaceDir(state.userId, t.id);
        changed = true;
      }
    }
    if (changed) this.store.write(state);
    return state;
  }

  /**
   * 新建任务：缺省自动生成全局唯一 key；customKey 可选（需符合格式且全局唯一）。
   * 返回任务（含 key），新建即激活。
   */
  createTask(state: UserTasks, name: string, agentId?: string, customKey?: string, cwd?: string): TaskItem {
    const id = newTaskId();
    const explicit = cwd?.trim();
    const workspace = explicit ? explicit : this.taskWorkspaceDir(state.userId, id);
    const task: TaskItem = {
      id,
      key: this.keyFor(customKey),
      keyEnabled: true,
      name: name.trim() || `任务 ${state.tasks.length + 1}`,
      agentId: agentId?.trim() || this.agentOf(state),
      ...(workspace ? { cwd: workspace } : {}),
      createdAt: Date.now(),
    };
    state.tasks.push(task);
    state.activeTaskId = task.id; // 新建即激活
    this.store.write(state);
    return task;
  }

  /** 生成或校验任务 key：自定义 key 需全局唯一；缺省自动生成 */
  private keyFor(customKey?: string): string {
    const k = customKey?.trim();
    if (k) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) {
        throw new Error('任务 key 仅支持字母/数字/._-，最长 64 字符');
      }
      if (this.findByKey(k)) throw new Error(`任务 key 已存在: ${k}`);
      return k;
    }
    return newTaskKey();
  }

  /**
   * 全局反查：key → {channel, userId, task}（跨用户；用于单 key 直连路由）。
   * 遍历用户状态文件实现，个人部署量级下足够，且永远读最新数据、无索引一致性问题。
   */
  findByKey(key: string): { channel: string; userId: string; task: TaskItem } | undefined {
    const k = key.trim();
    if (!k) return undefined;
    for (const u of this.store.list()) {
      const state = this.store.read(u.channel, u.userId);
      if (!state) continue;
      const task = state.tasks.find((t) => t.key === k);
      if (task) return { channel: u.channel, userId: u.userId, task };
    }
    return undefined;
  }

  listTasks(state: UserTasks): TaskItem[] {
    return state.tasks;
  }

  /** 全部用户摘要（含任务数；按最近活跃倒序） */
  listUsers() {
    return this.store.list();
  }

  /** 全部用户的任务明细（管理后台「任务」页用：平铺每个用户的全部任务） */
  listAllTasks(): Array<{ channel: string; userId: string; activeTaskId: string; tasks: TaskItem[] }> {
    return this.store.list().map((u) => {
      const state = this.store.read(u.channel, u.userId);
      return {
        channel: u.channel,
        userId: u.userId,
        activeTaskId: state?.activeTaskId ?? u.activeTaskId,
        tasks: state?.tasks ?? [],
      };
    });
  }

  /** 删除用户全部状态（默认任务也一并删除，无痕重建） */
  deleteUser(channel: string, userId: string): void {
    this.store.remove(channel, userId);
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
          key: newTaskKey(),
          keyEnabled: true,
          name: DEFAULT_TASK_NAME,
          agentId: this.defaultAgentId,
          createdAt: Date.now(),
        });
      }
    }
    this.store.write(state);
    return state.tasks;
  }

  /** 修改任务绑定的 agent（如切换到 pi，让该任务由 pi 驱动） */
  setTaskAgent(state: UserTasks, id: string, agentId: string): TaskItem {
    const agent = agentId.trim().toLowerCase();
    if (!agent) throw new Error('agentId 必填');
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    task.agentId = agent;
    this.store.write(state);
    return task;
  }

  renameTask(state: UserTasks, id: string, name: string): TaskItem {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    task.name = name.trim() || task.name;
    this.store.write(state);
    return task;
  }

  /** 设置任务工作目录（agent 会话启动目录）；空串/undefined 清除回退：配了 workspaceRoot 则回落任务自动隔离目录，否则删除 cwd 用 agent 默认 */
  setTaskCwd(state: UserTasks, id: string, cwd?: string): TaskItem {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const trimmed = cwd?.trim();
    if (trimmed) task.cwd = trimmed;
    else if (this.workspaceRoot) task.cwd = this.taskWorkspaceDir(state.userId, task.id);
    else delete task.cwd;
    this.store.write(state);
    return task;
  }

  /** 停用/启用任务 key：停用后 taskKey 直连被拒（403），任务本体（微信/三元素路由）不受影响 */
  setKeyEnabled(state: UserTasks, id: string, enabled: boolean): TaskItem {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    task.keyEnabled = enabled;
    this.store.write(state);
    return task;
  }

  /**
   * 普通消息路由：taskId 缺省用激活任务；显式 taskId 即使不在列表中也保持
   * （按 sessionKey 隔离会话，agent 沿用激活任务的 agent）。
   */
  resolveRoute(state: UserTasks, taskId?: string): TaskRoute {
    const id = taskId?.trim() || state.activeTaskId || DEFAULT_TASK_ID;
    const task = state.tasks.find((t) => t.id === id);
    if (task) return { agentId: task.agentId, taskId: task.id, taskName: task.name, cwd: task.cwd };
    const active = state.tasks.find((t) => t.id === state.activeTaskId) ?? state.tasks[0];
    return { agentId: active?.agentId ?? this.defaultAgentId, taskId: id, taskName: id, cwd: active?.cwd };
  }

  /** 当前激活任务的 agent（新建任务缺省继承） */
  private agentOf(state: UserTasks): string {
    const active = state.tasks.find((t) => t.id === state.activeTaskId);
    return active?.agentId ?? this.defaultAgentId;
  }

  /**
   * 按引用定位任务：精确 id > 精确 key > 精确名称 > 列表序号(1-based) > 唯一前缀(id/key/名称)。
   * 供 use/del/rename 使用，让路由控制不必记 t_xxx 原始 id（/task list 也展示 id 与 key）。
   * 找不到返回 undefined（调用方报「任务不存在」）。
   */
  private findTask(state: UserTasks, ref: string): TaskItem | undefined {
    const key = ref.trim();
    if (!key) return undefined;
    const byId = state.tasks.find((t) => t.id === key);
    if (byId) return byId;
    const byKey = state.tasks.find((t) => t.key === key);
    if (byKey) return byKey;
    const byName = state.tasks.find((t) => t.name === key);
    if (byName) return byName;
    if (/^\d+$/.test(key)) {
      const nth = state.tasks[Number(key) - 1];
      if (nth) return nth;
    }
    const byPrefix = state.tasks.filter((t) => t.id.startsWith(key) || t.key.startsWith(key) || t.name.startsWith(key));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
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
        if (rest.length >= 2) {
          const last = rest[rest.length - 1]; // rest.length >= 2 保证存在
          if (last !== undefined && known.includes(last.toLowerCase())) {
            agentId = last.toLowerCase();
            name = rest.slice(0, -1).join(' ');
          }
        }
        const task = this.createTask(state, name, agentId);
        return {
          text: `✅ 已新建任务 [${task.name}]（${task.id} · ${task.key}）→ ${task.agentId}（已激活）`,
          activeTaskId: task.id,
          activeAgentId: task.agentId,
        };
      }
      case 'list': {
        const lines = state.tasks.map((t, i) => {
          const mark = t.id === state.activeTaskId ? ' ← 激活' : '';
          const cwd = t.cwd ? ` 📂 ${t.cwd}` : '';
          return `[${i + 1}] ${t.name}（${t.id} · ${t.key}）→ ${t.agentId}${cwd}${mark}`;
        });
        return { text: `📋 任务列表（${state.tasks.length}）：\n${lines.join('\n')}` };
      }
      case 'use': {
        const ref = parts[1];
        if (!ref) return { text: '用法：/task use <id|名称|序号>' };
        const task = this.findTask(state, ref);
        if (!task) return { text: `❌ 任务不存在: ${ref}` };
        this.activateTask(state, task.id);
        return {
          text: `🔀 已切换到 [${task.name}] → ${task.agentId}`,
          activeTaskId: task.id,
          activeAgentId: task.agentId,
        };
      }
      case 'default': {
        // 快捷切回默认任务（default 任务 id 即 'default'，不可删除）
        const task = this.activateTask(state, DEFAULT_TASK_ID);
        return {
          text: `🔀 已切换到默认任务 [${task.name}] → ${task.agentId}`,
          activeTaskId: task.id,
          activeAgentId: task.agentId,
        };
      }
      case 'del': {
        const ref = parts[1];
        if (!ref) return { text: '用法：/task del <id|名称|序号>' };
        const task = this.findTask(state, ref);
        if (!task) return { text: `❌ 任务不存在: ${ref}` };
        if (task.id === DEFAULT_TASK_ID) return { text: '❌ 默认任务不可删除' };
        this.deleteTask(state, task.id);
        const active = state.tasks.find((t) => t.id === state.activeTaskId);
        return {
          text: `🗑 已删除任务 ${task.name}（当前激活：${active?.name ?? '无'}）`,
          activeTaskId: state.activeTaskId,
          activeAgentId: active?.agentId,
        };
      }
      case 'rename': {
        const ref = parts[1];
        const name = parts.slice(2).join(' ');
        if (!ref || !name) return { text: '用法：/task rename <id|名称|序号> <新名称>' };
        const task = this.findTask(state, ref);
        if (!task) return { text: `❌ 任务不存在: ${ref}` };
        const renamed = this.renameTask(state, task.id, name);
        return { text: `✏️ 已重命名 → [${renamed.name}]` };
      }
      case 'cwd': {
        const ref = parts[1];
        const path = parts.slice(2).join(' ');
        if (!ref) return { text: '用法：/task cwd <id|名称|序号> <工作目录路径>' };
        const task = this.findTask(state, ref);
        if (!task) return { text: `❌ 任务不存在: ${ref}` };
        if (!path) {
          return { text: task.cwd ? `📂 [${task.name}] 工作目录: ${task.cwd}` : `📂 [${task.name}] 未设置工作目录（用 agent 默认）` };
        }
        const set = this.setTaskCwd(state, task.id, path);
        return { text: `📂 已设置 [${set.name}] 工作目录 → ${set.cwd ?? '（agent 默认）'}` };
      }
      case 'agent': {
        const ref = parts[1];
        const agentId = parts[2]?.toLowerCase();
        if (!ref || !agentId) return { text: '用法：/task agent <id|名称|序号> <agentId>' };
        if (!known.includes(agentId)) {
          return { text: `❌ 未知 agent: ${agentId}（可用：${[...KNOWN_AGENT_IDS, this.defaultAgentId].join('/')}）` };
        }
        const task = this.findTask(state, ref);
        if (!task) return { text: `❌ 任务不存在: ${ref}` };
        const set = this.setTaskAgent(state, task.id, agentId);
        return { text: `🔀 [${set.name}] agent → ${set.agentId}` };
      }
      case 'help':
        return {
          text: [
            '📌 任务命令：',
            '/task new <名称> [agent]    新建任务（agent: pi/opencode）',
            '/task list                 查看全部任务（带 id/key/序号）',
            '/task use <id|key|名称|序号> 切换到指定任务（支持唯一前缀）',
            '/task default              切回默认任务',
            '/task del <id|key|名称|序号> 删除任务（默认任务不可删）',
            '/task rename <id|key|名称|序号> <新名称>  重命名',
            '/task cwd <id|key|名称|序号> [路径]     查看/设置工作目录（不填路径=查看）',
            '/task agent <id|key|名称|序号> <agentId>  切换任务绑定 agent（id/key/会话不变）',
            '普通消息自动进入「激活任务」对应的 agent。',
          ].join('\n'),
        };
      default:
        return { text: `❌ 未知命令 /task ${cmd}（/task help 查看用法）` };
    }
  }
}
