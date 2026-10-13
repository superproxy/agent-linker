import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  dockerDevProcess,
  normalizeContainerDevProcesses,
  resolveNodeTaskCwd,
  resolveTaskSwitchProcesses,
  taskProcessesFromConfig,
  TaskProcessGroup,
  type TaskProcessSpec,
} from '../../src/node/task-processes.js';

test('切换任务：停掉上一组进程，在新目录按命令拉起', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-proc-'));
  const spawned: { command: string[]; cwd: string }[] = [];
  const killed: string[] = [];
  const group = new TaskProcessGroup((command, cwd) => {
    spawned.push({ command, cwd });
    const id = command.join(' ');
    return {
      kill() {
        killed.push(id);
      },
    };
  });
  const dev: TaskProcessSpec = { id: 'dev', command: ['npm', 'run', 'dev'] };
  group.switchTo('t_a', join(root, 'a'), [dev]);
  assert.equal(group.currentTaskId(), 't_a');
  assert.equal(spawned.length, 1);

  group.switchTo('t_a', join(root, 'a'), [dev]);
  assert.equal(spawned.length, 2, '同任务再次下发 dev 时应重启进程');
  assert.deepEqual(spawned[0]?.command, ['npm', 'run', 'dev']);
  assert.equal(spawned[0]?.cwd, join(root, 'a'));

  group.switchTo('t_a', join(root, 'a'), [dev]);
  assert.equal(spawned.length, 3, '同任务第三次下发 dev 仍应重启进程');

  group.switchTo('t_b', join(root, 'b'), [{ id: 'vnc', command: ['echo', 'vnc'] }]);
  assert.deepEqual(killed, ['npm run dev', 'npm run dev', 'npm run dev']);
  assert.equal(group.currentTaskId(), 't_b');
  assert.equal(spawned.length, 4);
  assert.equal(spawned[3]?.cwd, join(root, 'b'));

  group.stop();
  assert.equal(group.currentTaskId(), '');
  assert.deepEqual(killed, ['npm run dev', 'npm run dev', 'npm run dev', 'echo vnc']);
});

test('容器工作区把宿主机任务目录换到 /root/workspace/<taskId>', () => {
  const host = 'D:/work/alice/t_abc';
  assert.equal(resolveNodeTaskCwd(host, undefined, 't_abc'), host);
  assert.equal(resolveNodeTaskCwd('/root/workspace/t_abc', '/root/workspace', 't_abc'), '/root/workspace/t_abc');
  assert.equal(resolveNodeTaskCwd(host, '/root/workspace', 't_abc'), join('/root/workspace', 't_abc'));
  assert.equal(resolveNodeTaskCwd(host, '/root/workspace'), join('/root/workspace', 't_abc'));
});

test('normalizeContainerDevProcesses：本机不替换 dev 命令', () => {
  const custom: TaskProcessSpec[] = [{ id: 'dev', command: ['npm', 'run', 'dev'] }];
  assert.deepEqual(normalizeContainerDevProcesses(custom, '1'), custom);
});

test('容器未配 taskProcesses 时用 dev 命令，本机配置优先', () => {
  assert.deepEqual(taskProcessesFromConfig([], undefined), []);
  assert.deepEqual(taskProcessesFromConfig([], '1'), []);
  assert.equal(dockerDevProcess().command[0], 'sh');
  assert.match(dockerDevProcess().command.join('\n'), /allowedHosts: true/);
  assert.match(dockerDevProcess().command.join('\n'), /LINKAGENT_ACTIVE_TASK_ID/);
  assert.match(dockerDevProcess().command.join('\n'), /base: "\/\$\{task\}\/"/);
  const custom: TaskProcessSpec[] = [{ id: 'app', command: ['npm', 'start'] }];
  assert.deepEqual(taskProcessesFromConfig(custom, '1'), custom);
});

test('未带 processes 时用节点配置，消息里的列表覆盖配置', () => {
  const configured: TaskProcessSpec[] = [{ id: 'dev', command: ['npm', 'run', 'dev'] }];
  assert.deepEqual(resolveTaskSwitchProcesses(configured, undefined), configured);
  assert.deepEqual(resolveTaskSwitchProcesses(configured, []), []);
  assert.deepEqual(
    resolveTaskSwitchProcesses(configured, [{ id: ' vnc ', command: [' echo ', 'vnc'] }]),
    [{ id: 'vnc', command: ['echo', 'vnc'] }],
  );
  assert.deepEqual(resolveTaskSwitchProcesses(configured, [{ id: ' ', command: ['npm'] }]), []);
});
