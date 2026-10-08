import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { registerRemoteModule } from '../../src/remote/index.js';
import { IdeWorkspaceError, isInsideWorkspace } from '../../src/remote/ide-workspace.js';

async function boot(baseDir: string, auth: { authed: boolean; admin: boolean }) {
  const app = Fastify();
  await registerRemoteModule(app, {
    baseDir,
    checkAuth: () => auth.authed,
    isAdmin: () => auth.admin,
  });
  return app;
}

test('isInsideWorkspace 拒绝跑出根目录', () => {
  const base = join(tmpdir(), 'ide-root');
  assert.equal(isInsideWorkspace(base, join(base, 'a', 'b')), true);
  assert.equal(isInsideWorkspace(base, join(base, '..', 'secret')), false);
});

test('未登录 401，非管理员 403', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ide-auth-'));
  const anon = await boot(dir, { authed: false, admin: false });
  const user = await boot(dir, { authed: true, admin: false });
  try {
    assert.equal((await anon.inject({ method: 'GET', url: '/api/remote/files/list' })).statusCode, 401);
    assert.equal((await user.inject({ method: 'GET', url: '/api/remote/files/list' })).statusCode, 403);
  } finally {
    await anon.close();
    await user.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('工作区内写入、读取，并拒绝目录穿越', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ide-files-'));
  const app = await boot(dir, { authed: true, admin: true });
  try {
    const written = await app.inject({
      method: 'PUT',
      url: '/api/remote/files/content',
      payload: { path: 'notes/todo.txt', content: 'hello' },
    });
    assert.equal(written.statusCode, 404, written.body);

    const made = await app.inject({
      method: 'POST',
      url: '/api/remote/files/mkdir',
      payload: { path: 'notes' },
    });
    assert.equal(made.statusCode, 200, made.body);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/remote/files/content',
      payload: { path: 'notes/todo.txt', content: 'hello' },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(await readFile(join(dir, 'notes', 'todo.txt'), 'utf8'), 'hello');

    const read = await app.inject({ method: 'GET', url: '/api/remote/files/content?path=notes/todo.txt' });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().content, 'hello');

    const escaped = await app.inject({ method: 'GET', url: '/api/remote/files/content?path=../secret.txt' });
    assert.equal(escaped.statusCode, 403);

    const listed = await app.inject({ method: 'GET', url: '/api/remote/files/list?path=notes' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().entries[0].name, 'todo.txt');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('指向工作区外的符号链接不可读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ide-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'ide-outside-'));
  const app = await boot(dir, { authed: true, admin: true });
  try {
    await writeFile(join(outside, 'secret.txt'), 'hidden');
    try {
      await symlink(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP') return;
      throw err;
    }
    const res = await app.inject({ method: 'GET', url: '/api/remote/files/content?path=leak.txt' });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('终端在工作区目录执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ide-term-'));
  const app = await boot(dir, { authed: true, admin: true });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/remote/terminal',
      payload: { command: 'echo ide-ok' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.json().stdout), /ide-ok/);
    const empty = await app.inject({ method: 'POST', url: '/api/remote/terminal', payload: { command: '   ' } });
    assert.equal(empty.statusCode, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspaceForTask 返回任务自己的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-cwd-'));
  try {
    const svc = new TaskService({
      store: createJsonStore(join(root, 'state')),
      workspaceRoot: join(root, 'ws'),
    });
    const space = svc.ensureLoginSpace('alice');
    const task = svc.createTask(space, 'demo');
    const dir = svc.workspaceForTask('alice', task.id);
    assert.equal(dir, resolve(task.cwd ?? ''));
    assert.equal(existsSync(dir), true);
    const custom = join(root, 'custom');
    const picked = svc.createTask(space, 'picked', undefined, undefined, custom);
    assert.equal(svc.workspaceForTask('alice', picked.id), resolve(custom));
    assert.throws(() => svc.workspaceForTask('alice', 't_missing'), /任务不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('任务 IDE 使用任务目录，非管理员不能进默认工作区', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ide-task-'));
  const base = join(root, 'default');
  const taskDir = join(root, 'task');
  const outside = join(root, 'secret.txt');
  await mkdir(base, { recursive: true });
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'note.txt'), 'hi');
  await writeFile(join(base, 'other.txt'), 'no');
  await writeFile(outside, 'secret');
  const app = Fastify();
  await registerRemoteModule(app, {
    baseDir: base,
    checkAuth: () => true,
    isAdmin: () => false,
    resolveTaskDir: (request) => {
      const id = (request.query as { taskId?: string }).taskId;
      if (id === 't_ok') return taskDir;
      throw new IdeWorkspaceError('任务不存在', 404, 'not_found');
    },
  });
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/remote/files/list' });
    assert.equal(denied.statusCode, 403);
    const ok = await app.inject({ method: 'GET', url: '/api/remote/files/list?taskId=t_ok' });
    assert.equal(ok.statusCode, 200, ok.body);
    const names = (ok.json() as { entries: { name: string }[] }).entries.map((e) => e.name);
    assert.deepEqual(names, ['note.txt']);
    const missing = await app.inject({ method: 'GET', url: '/api/remote/files/list?taskId=nope' });
    assert.equal(missing.statusCode, 404);
    const escape = await app.inject({
      method: 'GET',
      url: `/api/remote/files/content?taskId=t_ok&path=${encodeURIComponent('../secret.txt')}`,
    });
    assert.equal(escape.statusCode, 403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
