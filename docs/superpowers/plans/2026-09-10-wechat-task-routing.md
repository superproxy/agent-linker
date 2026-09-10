# 微信多任务路由实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让微信/企微用户通过单一聊天窗口创建多个任务（各绑定不同 agent），用 `/task` 命令切换，网关按 `agent+userId+task` 路由执行，任务会话独立隔离。

**Architecture:** 网关内新增独立公共子系统 `backend/src/gateway/tasks/`（TaskService + JSON 持久化 + 命令解析 + `/api/tasks`），`/v1/chat/completions` 扩展 `channel/userId/agent/task` 参数（命令本地解析回文本、普通消息按激活任务路由）。各 bot 用共享 `TaskRouter` 维护"当前选中任务"内存缓存（网关 `activeTaskId` 为单一事实源）。

**Tech Stack:** TypeScript（ESM，`tsx` 运行）、Fastify、Node 内置 test runner（`node:test` + `tsx --test`）、zod（shared config）

**Spec:** `docs/superpowers/specs/2026-09-10-wechat-task-routing-design.md`

---

## 文件结构

```
backend/src/gateway/tasks/
├── types.ts        # 类型 + 常量（TaskItem / UserTasks / CommandResult / 命令前缀 / default 任务）
├── store.ts        # JSON 持久化层（.runtime-state/tasks/<channel>.<userId>.json）
├── service.ts      # TaskService：load/create/list/activate/delete/rename/resolveRoute/handleCommand（纯逻辑）
└── api.ts          # registerTaskApi（/api/tasks）+ decideTaskRouting（/v1 命令/路由决策）
backend/src/channels/task-router.ts   # bot 路由层：TaskRouter（选中任务缓存 + /api/tasks 同步）
backend/test/tasks/
├── store.test.ts
├── service.test.ts
├── api.test.ts
└── gateway.test.ts   # buildServer 集成（/v1 命令分支 + 兼容分支）
```

修改文件：
- `backend/src/gateway/index.ts` — 初始化 TaskService、/v1 分支接入、挂 /api/tasks
- `backend/src/channels/gateway-chat.ts` — `streamChat` 参数扩展（channel/agent/userId/task）
- `backend/src/channels/weixin-bot.ts` — 接入 TaskRouter
- `shared/src/config.ts` — `tasks.defaultAgentId` 配置
- `backend/config/gateway.yaml` — 加 tasks 配置、weixin.mode 切 weixin-bot
- `backend/package.json` — 加 test script

依赖方向：`api → service → store`；`task-router` 仅依赖 HTTP（/api/tasks 与 /v1）。

---

### Task 1: TaskStore（JSON 持久化层）

**Files:**
- Create: `backend/src/gateway/tasks/types.ts`
- Create: `backend/src/gateway/tasks/store.ts`
- Test: `backend/test/tasks/store.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import type { UserTasks } from '../../src/gateway/tasks/types.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
}

test('read 不存在的用户返回 null', () => {
  const store = createJsonStore(freshDir());
  assert.equal(store.read('weixin', 'wx_1'), null);
});

test('write 后 read 还原，文件名安全转义', () => {
  const dir = freshDir();
  const store = createJsonStore(dir);
  const data: UserTasks = {
    channel: 'weixin',
    userId: 'wx_1',
    activeTaskId: 'default',
    tasks: [{ id: 'default', name: '默认', agentId: 'opencode', createdAt: 123 }],
  };
  store.write(data);
  assert.deepEqual(store.read('weixin', 'wx_1'), data);
  // 用户 id 含特殊字符（微信 openid 等）时文件名安全
  store.write({ channel: 'weixin', userId: 'a/b?c', activeTaskId: 'default', tasks: [] });
  assert.deepEqual(store.read('weixin', 'a/b?c'), { channel: 'weixin', userId: 'a/b?c', activeTaskId: 'default', tasks: [] });
});

test('损坏的 JSON 返回 null（调用方重建）', () => {
  const dir = freshDir();
  const file = join(dir, 'weixin.x.json');
  writeFileSync(file, '{broken json', 'utf8');
  const store = createJsonStore(dir);
  assert.equal(store.read('weixin', 'x'), null);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// backend/src/gateway/tasks/types.ts
/** 任务（一个任务 = 一个绑定特定 agent 的持久会话） */
export interface TaskItem {
  id: string;
  name: string;
  agentId: string;
  createdAt: number;
}

/** 单个渠道用户的全部任务状态（网关为单一事实源，落盘） */
export interface UserTasks {
  channel: string;
  userId: string;
  /** 当前激活任务 id（web 点击 / 微信命令都写这里） */
  activeTaskId: string;
  tasks: TaskItem[];
}

/** 路由解析结果：普通消息发往的 agent + 会话任务 */
export interface TaskRoute {
  agentId: string;
  taskId: string;
  taskName: string;
}

/** /task 命令处理结果 */
export interface CommandResult {
  text: string;
  /** 命令导致激活变化时带回（供 bot 同步，可选） */
  activeTaskId?: string;
  activeAgentId?: string;
}

export const TASK_COMMAND_PREFIX = '/task';
export const DEFAULT_TASK_ID = 'default';
export const DEFAULT_TASK_NAME = '默认';
export const DEFAULT_AGENT_ID = 'opencode';
/** 命令里可识别的 agent 别名（new 的第二个可选参数） */
export const KNOWN_AGENT_IDS = ['pi', 'opencode'] as const;
```

```ts
// backend/src/gateway/tasks/store.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserTasks } from './types.js';

/** 用户状态文件名：<channel>.<userId>.json，特殊字符转义防路径注入 */
export function tasksFileFor(stateDir: string, channel: string, userId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe(channel)}.${safe(userId)}.json`);
}

export interface TaskStore {
  read(channel: string, userId: string): UserTasks | null;
  write(data: UserTasks): void;
}

export function createJsonStore(stateDir: string): TaskStore {
  return {
    read(channel, userId) {
      const file = tasksFileFor(stateDir, channel, userId);
      if (!existsSync(file)) return null;
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as UserTasks;
        if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return null;
        return data;
      } catch {
        return null; // 损坏：调用方按空状态重建
      }
    },
    write(data) {
      mkdirSync(stateDir, { recursive: true });
      const file = tasksFileFor(stateDir, data.channel, data.userId);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      rmSync(tmp, { force: true });
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/store.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/tasks/types.ts backend/src/gateway/tasks/store.ts backend/test/tasks/store.test.ts
git commit -m "feat(tasks): TaskStore JSON 持久化层 + 类型定义"
```

---

### Task 2: TaskService 核心 CRUD + 默认任务

**Files:**
- Create: `backend/src/gateway/tasks/service.ts`
- Test: `backend/test/tasks/service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/service.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { DEFAULT_TASK_ID } from '../../src/gateway/tasks/types.js';

function freshService(): TaskService {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  return new TaskService({ store: createJsonStore(dir) });
}

test('首次 load 预置 default 任务', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, DEFAULT_TASK_ID);
  assert.equal(state.tasks[0].agentId, 'opencode');
  assert.equal(state.activeTaskId, DEFAULT_TASK_ID);
});

test('createTask 追加并激活，agent 缺省继承当前激活', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '写方案', 'pi');
  assert.equal(state.tasks.length, 2);
  assert.equal(state.activeTaskId, t.id);
  assert.equal(t.agentId, 'pi');
  const t2 = svc.createTask(state, '另一个'); // agent 缺省继承 pi
  assert.equal(t2.agentId, 'pi');
});

test('activate / delete / rename', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查bug', 'opencode');
  svc.createTask(state, '写方案', 'pi');
  const back = svc.activateTask(state, DEFAULT_TASK_ID);
  assert.equal(state.activeTaskId, DEFAULT_TASK_ID);
  assert.equal(back.id, DEFAULT_TASK_ID);
  assert.throws(() => svc.activateTask(state, 'nope'), /任务不存在/);
  assert.throws(() => svc.deleteTask(state, DEFAULT_TASK_ID), /默认任务不可删除/);
  svc.deleteTask(state, t.id);
  assert.ok(!state.tasks.some((x) => x.id === t.id));
  const renamed = svc.renameTask(state, DEFAULT_TASK_ID, '主任务');
  assert.equal(renamed.name, '主任务');
});

test('删除激活任务后回落到剩余第一个', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const a = svc.createTask(state, 'A', 'pi');
  svc.createTask(state, 'B', 'opencode');
  svc.activateTask(state, a.id);
  svc.deleteTask(state, a.id);
  assert.notEqual(state.activeTaskId, a.id);
  assert.ok(state.tasks.some((x) => x.id === state.activeTaskId));
});

test('resolveRoute 缺省用激活任务，可覆盖', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查', 'pi');
  const r1 = svc.resolveRoute(state);
  assert.equal(r1.taskId, t.id);
  assert.equal(r1.agentId, 'pi');
  const r2 = svc.resolveRoute(state, DEFAULT_TASK_ID);
  assert.equal(r2.taskId, DEFAULT_TASK_ID);
  assert.equal(r2.agentId, 'opencode');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// backend/src/gateway/tasks/service.ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/service.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/tasks/service.ts backend/test/tasks/service.test.ts
git commit -m "feat(tasks): TaskService CRUD + 默认任务预置"
```

---

### Task 3: /task 命令解析（handleCommand）

**Files:**
- Modify: `backend/src/gateway/tasks/service.ts`（追加 handleCommand）
- Test: `backend/test/tasks/service.test.ts`（追加命令用例）

- [ ] **Step 1: 追加失败测试**

```ts
// backend/test/tasks/service.test.ts 末尾追加
test('handleCommand: new 解析名称与可选 agent', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const r = svc.handleCommand(state, '/task new 写方案 pi')!;
  assert.ok(r.text.includes('写方案'));
  assert.equal(r.activeTaskId, state.activeTaskId);
  const t = state.tasks.find((x) => x.id === state.activeTaskId)!;
  assert.equal(t.name, '写方案');
  assert.equal(t.agentId, 'pi');
});

test('handleCommand: new 无 agent 继承当前', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const r = svc.handleCommand(state, '/task new 另一个')!;
  assert.equal(r.activeAgentId, 'opencode');
  assert.equal(state.tasks.find((x) => x.id === state.activeTaskId)!.agentId, 'opencode');
});

test('handleCommand: list 带激活标记', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  svc.handleCommand(state, '/task new 排查 pi')!;
  const r = svc.handleCommand(state, '/task list')!;
  assert.ok(r.text.includes('默认'));
  assert.ok(r.text.includes('排查'));
  assert.ok(r.text.includes('激活'));
});

test('handleCommand: use / del / rename / help / 错误分支', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查', 'pi');
  const rUse = svc.handleCommand(state, `/task use ${t.id}`)!;
  assert.equal(rUse.activeTaskId, t.id);
  assert.equal(rUse.activeAgentId, 'pi');
  const rRename = svc.handleCommand(state, `/task rename ${t.id} 大排查`)!;
  assert.ok(rRename.text.includes('大排查'));
  const rDel = svc.handleCommand(state, `/task del ${t.id}`)!;
  assert.ok(rDel.text.includes('已删除'));
  assert.ok(!state.tasks.some((x) => x.id === t.id));
  const rHelp = svc.handleCommand(state, '/task help')!;
  assert.ok(rHelp.text.includes('/task new'));
  const rBad = svc.handleCommand(state, '/task del nope')!;
  assert.ok(rBad.text.includes('任务不存在'));
  const rDelDefault = svc.handleCommand(state, '/task del default')!;
  assert.ok(rDelDefault.text.includes('默认任务不可删除'));
});

test('handleCommand: 非命令返回 null', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  assert.equal(svc.handleCommand(state, '你好呀'), null);
  assert.equal(svc.handleCommand(state, '/taskx'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/service.test.ts`
Expected: FAIL（`svc.handleCommand is not a function`）

- [ ] **Step 3: 实现 handleCommand**

在 `backend/src/gateway/tasks/service.ts` 的类内追加：

```ts
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
```

同时把 `KNOWN_AGENT_IDS` 加入 import：`import { DEFAULT_AGENT_ID, DEFAULT_TASK_ID, DEFAULT_TASK_NAME, KNOWN_AGENT_IDS, TASK_COMMAND_PREFIX, ... } from './types.js';`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/service.test.ts`
Expected: PASS（全部用例，含新增 5 个命令用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/tasks/service.ts backend/test/tasks/service.test.ts
git commit -m "feat(tasks): /task 命令解析（new/list/use/del/rename/help）"
```

---

### Task 4: /v1 任务路由决策（decideTaskRouting）

**Files:**
- Create: `backend/src/gateway/tasks/api.ts`
- Test: `backend/test/tasks/api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { decideTaskRouting } from '../../src/gateway/tasks/api.js';

function freshService(): TaskService {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  return new TaskService({ store: createJsonStore(dir) });
}

test('无 channel/userId → legacy（原 model+sessionKey 路径）', () => {
  const svc = freshService();
  const d = decideTaskRouting(svc, { text: '你好', channel: '', userId: '' });
  assert.equal(d.kind, 'legacy');
});

test('命令 → command，返回文本，状态变更落盘', () => {
  const svc = freshService();
  const d = decideTaskRouting(svc, { text: '/task new 写方案 pi', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'command');
  assert.ok(d.text!.includes('写方案'));
  // 落盘持久化：重新 load 可见
  const state = svc.load('weixin', 'wx_1');
  assert.equal(state.tasks.length, 2);
});

test('普通消息 → chat，解析激活任务 agent+task，sessionKey 编码任务', () => {
  const svc = freshService();
  svc.load('weixin', 'wx_1');
  const d = decideTaskRouting(svc, { text: '帮我写方案', channel: 'weixin', userId: 'wx_1' });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'opencode');
  assert.equal(d.taskId, 'default');
  assert.equal(d.sessionKey, 'weixin:wx_1:task:default');
});

test('普通消息带 agent/task 参数 → 覆盖路由', () => {
  const svc = freshService();
  svc.load('weixin', 'wx_1');
  const d = decideTaskRouting(svc, {
    text: '继续排查',
    channel: 'weixin',
    userId: 'wx_1',
    agent: 'pi',
    task: 't_x',
  });
  assert.equal(d.kind, 'chat');
  assert.equal(d.agentId, 'pi');
  assert.equal(d.taskId, 't_x');
  assert.equal(d.sessionKey, 'weixin:wx_1:task:t_x');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/api.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// backend/src/gateway/tasks/api.ts
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
    return { kind: 'command', text: result.text, activeTaskId: result.activeTaskId, activeAgentId: result.activeAgentId };
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/api.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/tasks/api.ts backend/test/tasks/api.test.ts
git commit -m "feat(tasks): /v1 任务路由决策（命令/普通消息/legacy 三分支）"
```

---

### Task 5: 网关集成（buildServer 初始化 + /v1 分支 + 兼容）

**Files:**
- Modify: `backend/src/gateway/index.ts`
- Test: `backend/test/tasks/gateway.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/gateway.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/gateway/index.js';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';

test('GET /v1/models 正常（agent 列表）', async () => {
  const built = await buildServer({
    definitions: [
      { id: 'opencode', type: 'opencode', displayName: 'OpenCode' },
      { id: 'pi', type: 'pi', displayName: 'Pi', model: 'volcengine/deepseek-v4-flash-ga-260731' },
    ],
  });
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().data.some((m: { id: string }) => m.id === 'agent:opencode'));
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('POST /v1 命令分支：/task list 返回文本且不走 agent', async () => {
  const built = await buildServer({ definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] });
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'agent:opencode',
        channel: 'weixin',
        userId: 'gw_test_1',
        messages: [{ role: 'user', content: '/task new 集成测试 pi' }],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.choices[0].message.content.includes('集成测试'));
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('POST /v1 命令分支 stream=true：SSE 单块返回', async () => {
  const built = await buildServer({ definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] });
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'agent:opencode',
        stream: true,
        channel: 'weixin',
        userId: 'gw_test_2',
        messages: [{ role: 'user', content: '/task list' }],
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('data:'));
    assert.ok(res.body.includes('[DONE]'));
    assert.ok(res.body.includes('任务列表'));
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('POST /v1 兼容分支：无 channel/userId 走原逻辑（未知模型 404）', async () => {
  const built = await buildServer({ definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] });
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'agent:unknown',
        messages: [{ role: 'user', content: '你好' }],
      },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/gateway.test.ts`
Expected: FAIL（buildServer 尚无 channel/userId 支持）

- [ ] **Step 3: 实现网关集成**

修改 `backend/src/gateway/index.ts`：

1) 顶部 import 追加：

```ts
import { join } from 'node:path';
import { createJsonStore } from './tasks/store.js';
import { TaskService } from './tasks/service.js';
import { decideTaskRouting } from './tasks/api.js';
import { registerTaskApi } from './tasks/api.js';
```

2) `buildServer` 内、`const app = Fastify(...)` 之后初始化：

```ts
  // ── 任务公共能力（多渠道共享；state 落在 <repo>/.runtime-state/tasks/）──
  const taskStateDir = join(findRepoRoot(), '.runtime-state', 'tasks');
  // 缺省 defaultAgentId=opencode；config 接线在 Task 7（config.tasks.defaultAgentId）
  const taskService = new TaskService({ store: createJsonStore(taskStateDir) });
  registerTaskApi(app, taskService, (req) => checkAuth(req as FastifyRequest));
```

3) `POST /v1/chat/completions` handler 内，`messagesToText` 之后、`chatRequest` 之前插入路由决策：

```ts
    const prompt = messagesToText(body.messages);
    if (!prompt) {
      return reply.code(400).send(openaiError('messages 中没有可发送的文本', 'invalid_request_error', 'empty_messages'));
    }

    // ── 任务路由（渠道传 channel/userId/agent/task）──
    // 命令 → 本地解析回文本（不走 agent）；普通消息 → 激活任务派生 agentId+sessionKey；
    // 无 channel/userId → 原 model+sessionKey 路径（兼容）。
    const routing = decideTaskRouting(taskService, {
      channel: body.channel,
      userId: body.userId,
      agent: body.agent,
      task: body.task,
      text: prompt,
    });
    if (routing.kind === 'command') {
      if (body.stream !== true) {
        const result: ChatCompletion = {
          id: meta.id,
          object: 'chat.completion',
          created: meta.created,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: routing.text }, finish_reason: 'stop' }],
        };
        return result;
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      send(chunkDelta(meta, { role: 'assistant', content: routing.text }, 'stop'));
      res.write(SSE_DONE);
      res.end();
      return;
    }
    const modelForChat = routing.kind === 'chat' ? modelIdFor(routing.agentId) : body.model;
    const sessionKeyForChat = routing.kind === 'chat' ? routing.sessionKey : (typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '');
```

4) 用 `modelForChat` / `sessionKeyForChat` 替换后面原有的 `body.model` 与 sessionKey 逻辑：

```ts
    const adapter = manager.resolve(modelForChat);
    if (!adapter) {
      const known = manager.listDescriptors().map((d) => modelIdFor(d.id)).join(', ');
      return reply
        .code(404)
        .send(openaiError(`未知模型 "${modelForChat}"；可用: ${known}`, 'invalid_request_error', 'model_not_found'));
    }

    const chatRequest = {
      messages: [{ role: 'user' as const, content: prompt }],
      ...(sessionKeyForChat ? { sessionKey: sessionKeyForChat } : {}),
    };
    const meta = newMeta(modelForChat);
```

（`meta` 原在 prompt 之后创建，注意调整位置；两处 `newMeta(body.model)` 与 `model: body.model` 一并替换为 `modelForChat`。）

5) `buildServer` 返回对象追加 `taskService`：

```ts
  return { app, manager, pluginManager, weixinBot, taskService, host: ..., port: ..., authEnabled: ... };
```

6) `ChatCompletionRequest` 类型扩展（在 `shared/src/openai.ts` 或 index.ts 局部类型）——index.ts 内直接扩展请求体字段类型：

```ts
// 扩展请求体：linkagent 扩展字段（channel/userId/agent/task），shared ChatCompletionRequest 保持 OpenAI 兼容
type TaskAwareChatBody = ChatCompletionRequest & {
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  sessionKey?: string;
};
```

`app.post('/v1/chat/completions', async (request: FastifyRequest<{ Body: TaskAwareChatBody }>, reply) => ...`，并把 handler 内 `body` 断言更新。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/gateway.test.ts && npx tsc --noEmit`
Expected: PASS（4 个用例）+ typecheck 无错误

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/index.ts backend/test/tasks/gateway.test.ts
git commit -m "feat(gateway): /v1 接入任务路由（命令回文本/消息按激活任务路由/legacy 兼容）"
```

---

### Task 7: shared config 加 tasks 配置

**Files:**
- Modify: `shared/src/config.ts`
- Modify: `backend/config/gateway.yaml`

- [ ] **Step 1: 修改 config schema**

`shared/src/config.ts` 的 `gatewayConfigSchema` 内追加：

```ts
  /** 任务公共能力：默认任务绑定的 agent */
  tasks: z
    .object({
      defaultAgentId: z.string().default('opencode'),
    })
    .default({ defaultAgentId: 'opencode' }),
```

`defaultConfig()` 追加：

```ts
    tasks: { defaultAgentId: 'opencode' },
```

`backend/config/gateway.yaml` 追加：

```yaml
# ── 任务公共能力（多渠道共享）────────────────────────────
# tasks.defaultAgentId：每个用户默认任务绑定的 agent
tasks:
  defaultAgentId: opencode
```

- [ ] **Step 1b: buildServer 接线 defaultAgentId**

`backend/src/gateway/index.ts` 中任务初始化处改为读 config（Task 5 缺省值的正式接线）：

```ts
  const taskService = new TaskService({
    store: createJsonStore(taskStateDir),
    defaultAgentId: config.tasks.defaultAgentId,
  });
```

- [ ] **Step 2: typecheck**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add shared/src/config.ts backend/config/gateway.yaml
git commit -m "feat(config): tasks.defaultAgentId 配置项"
```

---

### Task 6: /api/tasks 管理接口（registerTaskApi）

**Files:**
- Modify: `backend/src/gateway/tasks/api.ts`（追加 registerTaskApi）
- Test: `backend/test/tasks/api.test.ts`（追加接口用例，用 fastify 轻量 app）

- [ ] **Step 1: 追加失败测试**

```ts
// backend/test/tasks/api.test.ts 末尾追加（注意原有 import 基础上追加 Fastify 相关）
import Fastify from 'fastify';
import { registerTaskApi } from '../../src/gateway/tasks/api.js';
import type { FastifyInstance } from 'fastify';

async function freshApp(): Promise<FastifyInstance> {
  const svc = freshService();
  const app = Fastify();
  registerTaskApi(app, svc, () => true); // 测试不鉴权
  await app.ready();
  return app;
}

test('/api/tasks: 首次 GET 返回默认任务（懒初始化落盘）', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.activeTaskId, 'default');
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].agentId, 'opencode');
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: POST 新建 + PATCH activate + DELETE', async () => {
  const app = await freshApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { channel: 'weixin', userId: 'wx_9', name: '写方案', agentId: 'pi' },
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();
    assert.equal(task.agentId, 'pi');
    assert.ok(task.id.startsWith('t_'));

    const list = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(list.json().activeTaskId, task.id); // 新建即激活

    const act = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/activate`,
      payload: { channel: 'weixin', userId: 'wx_9' },
    });
    assert.equal(act.statusCode, 200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}?channel=weixin&userId=wx_9`,
    });
    assert.equal(del.statusCode, 200);
    const list2 = await app.inject({ method: 'GET', url: '/api/tasks?channel=weixin&userId=wx_9' });
    assert.equal(list2.json().tasks.length, 1);
  } finally {
    await app.close().catch(() => {});
  }
});

test('/api/tasks: 删除 default 拒绝（400）', async () => {
  const app = await freshApp();
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/default?channel=weixin&userId=wx_9',
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close().catch(() => {});
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/api.test.ts`
Expected: FAIL（`registerTaskApi is not a function`）

- [ ] **Step 3: 写实现**

`backend/src/gateway/tasks/api.ts` 追加（import 追加 `FastifyInstance` 与 `DEFAULT_TASK_ID`）：

```ts
import type { FastifyInstance } from 'fastify';
import { DEFAULT_TASK_ID } from './types.js';

export type AuthCheck = (request: { headers: Record<string, string | string[] | undefined> }) => boolean;

/** 挂载 /api/tasks（鉴权与现有 /api/* 一致：checkAuth 闭包传入） */
export function registerTaskApi(app: FastifyInstance, service: TaskService, checkAuth: AuthCheck): void {
  const requireAuth = (request: { headers: Record<string, string | string[] | undefined> }, reply: { code(code: number): unknown }): boolean => {
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
```

注意：`registerTaskApi` 的 `checkAuth` 参数类型需与 `index.ts` 的 `checkAuth(request: FastifyRequest)` 兼容——在 index.ts 调用处适配：`registerTaskApi(app, taskService, (req) => checkAuth(req as FastifyRequest))`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/api.test.ts && npx tsc --noEmit`
Expected: PASS（4+3=7 个用例）+ typecheck 无错误

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/gateway/tasks/api.ts backend/test/tasks/api.test.ts
git commit -m "feat(tasks): /api/tasks 管理接口（list/create/activate/delete）"
```

---

### Task 8: streamChat 参数扩展（channel/agent/userId/task）

**Files:**
- Modify: `backend/src/channels/gateway-chat.ts`
- Test: `backend/test/tasks/gateway-chat.test.ts`（用本地 mock HTTP 服务断言请求体）

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/gateway-chat.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat } from '../../src/channels/gateway-chat.js';

async function withMockGateway(fn: (url: string, seen: { bodies: Record<string, unknown>[] }) => Promise<void>): Promise<void> {
  const seen = { bodies: [] as Record<string, unknown>[] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.bodies.push(JSON.parse(raw));
      // 返回一个 SSE 流
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('streamChat 携带 channel/agent/userId/task 参数', async () => {
  await withMockGateway(async (url, seen) => {
    const out = await streamChat({
      gatewayUrl: url,
      model: 'agent:opencode',
      sessionKey: 'weixin:wx_1:task:t_9',
      channel: 'weixin',
      agent: 'pi',
      userId: 'wx_1',
      task: 't_9',
      message: '你好',
    });
    assert.equal(out.text, 'hi');
    const body = seen.bodies[0];
    assert.equal(body.agent, 'pi');
    assert.equal(body.userId, 'wx_1');
    assert.equal(body.task, 't_9');
    assert.equal(body.channel, 'weixin');
    assert.equal(body.sessionKey, 'weixin:wx_1:task:t_9');
  });
});

test('streamChat 缺省不携带任务字段（兼容旧调用）', async () => {
  await withMockGateway(async (url, seen) => {
    await streamChat({ gatewayUrl: url, model: 'agent:opencode', sessionKey: 'k', message: 'hi' });
    const body = seen.bodies[0];
    assert.equal(body.agent, undefined);
    assert.equal(body.userId, undefined);
    assert.equal(body.task, undefined);
    assert.equal(body.channel, undefined);
    assert.equal(body.sessionKey, 'k');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/gateway-chat.test.ts`
Expected: FAIL（`StreamChatParams` 无这些字段，TS 报错 / 请求体缺字段）

- [ ] **Step 3: 写实现**

`backend/src/channels/gateway-chat.ts` 的 `StreamChatParams` 扩展并透传：

```ts
export interface StreamChatParams {
  gatewayUrl: string;
  model: string;
  /** 会话 key（渠道:用户[:task]，网关持久会话有记忆） */
  sessionKey?: string;
  /** 任务路由扩展字段（linkagent 非标准）：渠道标识 / 用户 id / agent / 任务 id */
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  message: string;
  signal?: AbortSignal;
  onReasoning?: (delta: string) => void;
  onText?: (delta: string) => void;
}
```

`streamChat` 的请求体改为：

```ts
  const res = await fetch(`${params.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: params.message }],
      stream: true,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.task ? { task: params.task } : {}),
    }),
    signal: params.signal,
  });
```

`runChatSession` 的 `RunChatSessionOptions` 同步扩展（新增同样的可选字段）并透传给 `streamChat`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/gateway-chat.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/channels/gateway-chat.ts backend/test/tasks/gateway-chat.test.ts
git commit -m "feat(channels): streamChat/runChatSession 透传任务路由参数"
```

---

### Task 9: TaskRouter（bot 路由层）

**Files:**
- Create: `backend/src/channels/task-router.ts`
- Test: `backend/test/tasks/task-router.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/tasks/task-router.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TaskRouter } from '../../src/channels/task-router.js';

async function withTaskApi(handler: (req: { url?: string }, res: import('node:http').ServerResponse) => void, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/tasks')) {
      handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('isCommand 识别 /task 前缀', () => {
  assert.equal(TaskRouter.isCommand('/task list'), true);
  assert.equal(TaskRouter.isCommand('/task'), true);
  assert.equal(TaskRouter.isCommand('你好'), false);
  assert.equal(TaskRouter.isCommand('/taskx'), false);
});

test('active 首次查询 /api/tasks 并缓存；第二次不查询', async () => {
  let queries = 0;
  const router = new TaskRouter({ gatewayUrl: '', channel: 'weixin' });
  await withTaskApi(
    (req, res) => {
      queries += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          channel: 'weixin',
          userId: 'wx_1',
          activeTaskId: 't_2',
          tasks: [
            { id: 'default', name: '默认', agentId: 'opencode', createdAt: 1 },
            { id: 't_2', name: '排查', agentId: 'pi', createdAt: 2 },
          ],
        }),
      );
    },
    async (base) => {
      const r1 = await router.active('wx_1');
      assert.equal(r1.agent, 'pi');
      assert.equal(r1.task, 't_2');
      const r2 = await router.active('wx_1');
      assert.deepEqual(r2, r1);
      assert.equal(queries, 1); // 缓存命中，未二次查询
      router.invalidate('wx_1');
      await router.active('wx_1');
      assert.equal(queries, 2); // 失效后重新查询
    },
  );
});

test('active 对 404/无激活任务回落 default+opencode', async () => {
  const router = new TaskRouter({ gatewayUrl: '', channel: 'weixin' });
  await withTaskApi(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ channel: 'weixin', userId: 'wx_1', activeTaskId: '', tasks: [] }));
    },
    async (base) => {
      const r = await router.active('wx_new');
      assert.equal(r.task, 'default');
      assert.equal(r.agent, 'opencode');
    },
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/task-router.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// backend/src/channels/task-router.ts
/**
 * bot 路由层（每个渠道一份实例）：维护"当前选中任务"内存缓存，
 * 网关 /api/tasks 的 activeTaskId 为单一事实源，本层只是缓存 + 失效。
 */
export interface TaskRouterOptions {
  /** 网关 base（http://127.0.0.1:8787） */
  gatewayUrl: string;
  /** 渠道标识（weixin / wecom） */
  channel: string;
}

export interface ActiveRoute {
  agent: string;
  task: string;
}

export class TaskRouter {
  private readonly gatewayUrl: string;
  private readonly channel: string;
  private readonly cache = new Map<string, ActiveRoute>();

  constructor(options: TaskRouterOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.channel = options.channel;
  }

  /** 是否任务命令（/task 前缀；与网关 isTaskCommand 对齐） */
  static isCommand(text: string): boolean {
    const t = text.trim().toLowerCase();
    return t === '/task' || t.startsWith('/task ');
  }

  /** 当前选中任务（缓存命中直接返回；未命中查 /api/tasks，取激活任务，兜底 default+opencode） */
  async active(userId: string): Promise<ActiveRoute> {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    let route: ActiveRoute = { agent: 'opencode', task: 'default' };
    try {
      const url = `${this.gatewayUrl}/api/tasks?channel=${encodeURIComponent(this.channel)}&userId=${encodeURIComponent(userId)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          activeTaskId?: string;
          tasks?: Array<{ id: string; agentId: string }>;
        };
        const activeId = data.activeTaskId || data.tasks?.[0]?.id || 'default';
        const active = data.tasks?.find((t) => t.id === activeId);
        route = { agent: active?.agentId ?? 'opencode', task: activeId };
      }
    } catch {
      // 查询失败回落默认路由，不阻断消息
    }
    this.cache.set(userId, route);
    return route;
  }

  /** 命令处理后失效缓存（下次普通消息重新查询） */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsx --test test/tasks/task-router.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/channels/task-router.ts backend/test/tasks/task-router.test.ts
git commit -m "feat(channels): TaskRouter bot 路由层（选中任务缓存 + /api/tasks 同步）"
```

---

### Task 10: weixin-bot 接入 TaskRouter
**Files:**
- Modify: `backend/src/channels/weixin-bot.ts`

- [ ] **Step 1: 接入**

`weixin-bot.ts` 顶部 import 追加：

```ts
import { TaskRouter } from './task-router.js';
```

`startWeixinBot` 内、`const log = ...` 之后创建路由层：

```ts
  const router = new TaskRouter({ gatewayUrl, channel: 'weixin' });
```

`handleMessage` 内替换 `const sessionKey = \`weixin:${from}\`;` 与 `runChatSession` 调用为：

```ts
    const isCmd = TaskRouter.isCommand(text);
    const route = isCmd ? null : await router.active(from);
    const out = await runChatSession({
      gatewayUrl,
      model,
      channel: 'weixin',
      userId: from,
      ...(isCmd
        ? { message: text } // 命令：网关本地解析，回文本
        : { agent: route!.agent, task: route!.task, message: text }), // 普通消息：按激活任务路由
      send: async (chunk) => {
        await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          to: from,
          text: chunk,
          contextToken: getContextToken(account.id, from) ?? msg.context_token,
          runId: randomUUID(),
        });
      },
      split: (t) => splitChunks(t, MAX_MSG_LEN),
      log,
    });
    if (isCmd) router.invalidate(from); // 命令改过任务状态，失效缓存
```

（`sessionKey` 变量删除——网关命令/路由分支自行派生；`runChatSession` 需要透传新字段，见 Task 8。）

- [ ] **Step 2: typecheck**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent/backend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 冒烟（不连真实微信）**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/channels/weixin-bot.ts
git commit -m "feat(weixin-bot): 接入 TaskRouter（命令转发网关/普通消息按激活任务路由）"
```

---

### Task 10b: wecom-bot 接入 TaskRouter（单聊走任务路由，群聊保持原样）

**Files:**
- Modify: `backend/src/channels/wecom-bot.ts`

- [ ] **Step 1: 接入**

`wecom-bot.ts` 顶部 import 追加：

```ts
import { TaskRouter } from './task-router.js';
```

`startWecomBot`（或对应工厂函数）内、`runChatSession` 所在作用域创建路由层：

```ts
  const router = new TaskRouter({ gatewayUrl, channel: 'wecom' });
```

`handleWecomMessage` 内替换 `const sessionKey = msg.chatId ? ... : ...;` 与 `runChatSession` 调用：

```ts
  // 群聊：保持原 sessionKey 行为（多人群聊窗口不套用个人任务路由）
  if (msg.chatId) {
    await runChatSession({
      gatewayUrl,
      model,
      sessionKey: `wecom:chat:${msg.chatId}`,
      message: text,
      send: (chunk) => sendWecomText(from, chunk),
      split: (t) => splitWecomChunks(t),
      log,
    });
    return;
  }
  // 单聊：任务路由（命令 → 网关本地解析；普通消息 → 激活任务）
  const isCmd = TaskRouter.isCommand(text);
  const route = isCmd ? null : await router.active(from);
  await runChatSession({
    gatewayUrl,
    model,
    channel: 'wecom',
    userId: from,
    ...(isCmd ? { message: text } : { agent: route!.agent, task: route!.task, message: text }),
    send: (chunk) => sendWecomText(from, chunk),
    split: (t) => splitWecomChunks(t),
    log,
  });
  if (isCmd) router.invalidate(from);
```

（`splitWecomChunks` 为文件中已有的企微切块函数名，按其实际命名替换；`runChatSession` 透传支持见 Task 8。）

- [ ] **Step 2: typecheck**

Run: `cd /Users/yangxuezeng/CodeBuddy/linkagent && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/src/channels/wecom-bot.ts
git commit -m "feat(wecom-bot): 单聊接入 TaskRouter（群聊保持原 sessionKey 行为）"
```

---

### Task 11: 收尾（package.json test script、配置切换、README、全量验证）

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/config/gateway.yaml`
- Modify: `README.md`（多渠道章节补充任务命令说明）

- [ ] **Step 1: package.json 加 test script**

`backend/package.json` scripts 追加：

```json
    "test": "tsx --test test/tasks/*.test.ts",
    "test:watch": "tsx --test --watch test/tasks/*.test.ts"
```

- [ ] **Step 2: gateway.yaml 切 weixin-bot 模式（任务路由当前以独立 botAgent 为准）**

`backend/config/gateway.yaml` 的 `weixin` 段改为：

```yaml
weixin:
  mode: weixin-bot
  model: agent:pi
```

并更新上方注释说明：weixin-bot 模式（默认）走独立 adapter，任务命令 `/task` 由网关解析；openclaw-weixin 插件模式暂不支持任务路由。保留 plugins 段注释示例（weixin-bot 模式自动跳过该插件）。

- [ ] **Step 3: README 补充任务能力说明**

README「多渠道」章节下新增小节「任务命令（多渠道共享）」：

```markdown
### 任务命令（多渠道共享，网关公共能力）

每个渠道用户拥有独立任务列表（`.runtime-state/tasks/`），每条任务绑定一个 agent、拥有独立持久会话：

| 命令 | 说明 |
|---|---|
| `/task new <名称> [agent]` | 新建任务并激活（agent: pi / opencode） |
| `/task list` | 查看全部任务（`← 激活` 标记当前） |
| `/task use <id>` | 切换到指定任务 |
| `/task del <id>` | 删除任务（默认任务不可删） |
| `/task rename <id> <新名>` | 重命名 |
| `/task help` | 用法说明 |

- 普通消息自动进入「激活任务」绑定的 agent 会话，各任务记忆互不串扰；
- 首次使用自动创建「默认」任务（agent 由 `tasks.defaultAgentId` 配置，缺省 opencode）；
- web 后台可经 `/api/tasks` 点击管理，与微信命令等价；
- 普通 OpenAI 客户端（不传 `channel/userId`）走原 `model + sessionKey` 路径，不受影响。
```

- [ ] **Step 4: 全量验证**

Run:
```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
pnpm typecheck
cd backend && pnpm test
```
Expected: typecheck PASS；全部单测 PASS（store/service/api/gateway/gateway-chat/task-router）

- [ ] **Step 5: 手动冒烟（本地起网关，curl 验证命令 + 路由）**

Run:
```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent/backend
# 终端 A：起网关
pnpm start
# 终端 B：命令分支
curl -s http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"agent:pi","channel":"weixin","userId":"smoke1","messages":[{"role":"user","content":"/task new 冒烟任务 pi"}]}'
# 期望：choices[0].message.content 含 "已新建任务 [冒烟任务] → pi"
curl -s http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"agent:pi","channel":"weixin","userId":"smoke1","messages":[{"role":"user","content":"/task list"}]}'
# 期望：任务列表含 默认 + 冒烟任务
# 路由状态：curl http://127.0.0.1:8787/api/tasks?channel=weixin&userId=smoke1
# 期望：activeTaskId = 新建任务的 t_xxx
```

- [ ] **Step 6: 提交**

```bash
cd /Users/yangxuezeng/CodeBuddy/linkagent
git add backend/package.json backend/config/gateway.yaml README.md
git commit -m "chore: test script + weixin-bot 模式切换 + README 任务命令文档"
```
