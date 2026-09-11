import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { DEFAULT_TASK_ID, type UserTasks } from '../../src/gateway/tasks/types.js';

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

test('handleCommand: use 支持名称/序号/唯一前缀定位', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '股票分析', 'pi');
  // 名称
  const r1 = svc.handleCommand(state, '/task use 股票分析')!;
  assert.equal(r1.activeTaskId, t.id);
  assert.equal(r1.activeAgentId, 'pi');
  // 序号（list 展示的 [1] 即默认任务）
  const r2 = svc.handleCommand(state, '/task use 1')!;
  assert.equal(r2.activeTaskId, DEFAULT_TASK_ID);
  assert.equal(r2.activeAgentId, 'opencode');
  // 唯一前缀（名称前缀）
  const r3 = svc.handleCommand(state, '/task use 股票')!;
  assert.equal(r3.activeTaskId, t.id);
  // 前缀歧义（id 前缀 't_' 能命中多个）→ 任务不存在
  svc.createTask(state, '汇率监控', 'opencode');
  const r4 = svc.handleCommand(state, '/task use t_')!;
  assert.ok(r4.text.includes('任务不存在'));
});

test('handleCommand: default 快捷切回默认任务', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  svc.createTask(state, '股票分析', 'pi');
  const r = svc.handleCommand(state, '/task default')!;
  assert.equal(r.activeTaskId, DEFAULT_TASK_ID);
  assert.equal(r.activeAgentId, 'opencode');
  // 幂等：重复切不回报错
  const r2 = svc.handleCommand(state, '/task default')!;
  assert.equal(r2.activeTaskId, DEFAULT_TASK_ID);
});

test('handleCommand: list 展示任务 id，new 回复携带新 id', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const rNew = svc.handleCommand(state, '/task new 排查 pi')!;
  assert.ok(rNew.text.includes('t_'));
  const r = svc.handleCommand(state, '/task list')!;
  assert.ok(r.text.includes('t_'));
  assert.ok(r.text.includes('默认'));
});

test('handleCommand: use/del/rename 不存在的引用报任务不存在', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  assert.ok(svc.handleCommand(state, '/task use 不存在的任务')!.text.includes('任务不存在'));
  assert.ok(svc.handleCommand(state, '/task del 不存在的任务')!.text.includes('任务不存在'));
  assert.ok(svc.handleCommand(state, '/task rename 不存在的任务 新名')!.text.includes('任务不存在'));
  // 默认任务不可删（按名称也不行）
  assert.ok(svc.handleCommand(state, '/task del 默认')!.text.includes('默认任务不可删除'));
});

test('任务 key：default 与新建任务均带全局唯一 key（k_ 前缀）', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  assert.ok(state.tasks[0].key.startsWith('k_'));
  const t = svc.createTask(state, '排查', 'pi');
  assert.ok(t.key.startsWith('k_'));
  assert.notEqual(t.key, state.tasks[0].key);
  // 不同用户自动生成也不冲突
  const state2 = svc.load('weixin', 'wx_2');
  const t2 = svc.createTask(state2, '周报', 'opencode');
  assert.notEqual(t2.key, t.key);
});

test('createTask 支持自定义 key；格式非法/全局重复报错', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '外部分享', 'pi', 'my-key-1');
  assert.equal(t.key, 'my-key-1');
  // 全局重复（另一用户也不行）
  const state2 = svc.load('weixin', 'wx_2');
  assert.throws(() => svc.createTask(state2, '撞 key', 'pi', 'my-key-1'), /任务 key 已存在/);
  // 格式非法
  assert.throws(() => svc.createTask(state, '坏 key', 'pi', 'bad key!'), /仅支持/);
});

test('findByKey 全局反查与找不到', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '排查', 'pi');
  const ref = svc.findByKey(t.key);
  assert.ok(ref);
  assert.equal(ref!.channel, 'weixin');
  assert.equal(ref!.userId, 'wx_1');
  assert.equal(ref!.task.id, t.id);
  assert.equal(svc.findByKey('k_nonexist'), undefined);
  assert.equal(svc.findByKey(''), undefined);
});

test('旧数据（无 key）load 时惰性补齐并落盘，幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  const store = createJsonStore(dir);
  // 直接写无 key 的旧格式数据（模拟升级前落盘文件）
  store.write({
    channel: 'weixin',
    userId: 'wx_old',
    activeTaskId: 'default',
    tasks: [{ id: 'default', name: '默认', agentId: 'opencode', createdAt: Date.now() }],
  } as unknown as UserTasks);
  const svc = new TaskService({ store });
  const state = svc.load('weixin', 'wx_old');
  assert.ok(state.tasks[0].key.startsWith('k_'));
  // 已补齐并落盘
  const reread = store.read('weixin', 'wx_old');
  assert.ok(reread?.tasks[0].key.startsWith('k_'));
  // 幂等：再次 load 不重复生成
  const again = svc.load('weixin', 'wx_old');
  assert.equal(again.tasks[0].key, state.tasks[0].key);
});

test('handleCommand: /task use 支持 key 定位，list/new 展示 key', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '股票', 'pi');
  const rUse = svc.handleCommand(state, `/task use ${t.key}`)!;
  assert.equal(rUse.activeTaskId, t.id);
  assert.equal(rUse.activeAgentId, 'pi');
  const rList = svc.handleCommand(state, '/task list')!;
  assert.ok(rList.text.includes(t.key));
  const rNew = svc.handleCommand(state, '/task new 分享 pi')!;
  assert.ok(rNew!.text.includes('k_'));
});

test('任务 key 缺省启用；setKeyEnabled 停用/启用并落盘', () => {
  const svc = freshService();
  const state = svc.load('weixin', 'wx_1');
  const t = svc.createTask(state, '分享', 'pi');
  assert.equal(t.keyEnabled, true);
  const disabled = svc.setKeyEnabled(state, t.id, false);
  assert.equal(disabled.keyEnabled, false);
  // 已落盘（重新 load 仍为停用）
  const persisted = svc.load('weixin', 'wx_1');
  assert.equal(persisted.tasks.find((x) => x.id === t.id)!.keyEnabled, false);
  // 重新启用
  const enabled = svc.setKeyEnabled(state, t.id, true);
  assert.equal(enabled.keyEnabled, true);
  // 找不到任务报错
  assert.throws(() => svc.setKeyEnabled(state, 'nope', false), /任务不存在/);
});

test('旧数据（无 keyEnabled）load 时惰性补齐 true 并落盘，幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-tasks-'));
  const store = createJsonStore(dir);
  store.write({
    channel: 'weixin',
    userId: 'wx_old2',
    activeTaskId: 'default',
    tasks: [{ id: 'default', key: 'k_old', name: '默认', agentId: 'opencode', createdAt: Date.now() }],
  } as unknown as UserTasks);
  const svc = new TaskService({ store });
  const state = svc.load('weixin', 'wx_old2');
  assert.equal(state.tasks[0].keyEnabled, true);
  const reread = store.read('weixin', 'wx_old2');
  assert.equal(reread?.tasks[0].keyEnabled, true);
  // 幂等：不覆盖手动停用状态
  svc.setKeyEnabled(state, 'default', false);
  const again = svc.load('weixin', 'wx_old2');
  assert.equal(again.tasks[0].keyEnabled, false);
});
