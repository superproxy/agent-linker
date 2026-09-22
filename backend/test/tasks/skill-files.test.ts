import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createJsonStore } from '../../src/gateway/tasks/store.js';
import { TaskService } from '../../src/gateway/tasks/service.js';
import { registerTaskApi, decideTaskRouting } from '../../src/gateway/tasks/api.js';
import {
  identityForLoginTask,
  isSkillRequest,
  readTaskSkillMarkdown,
  TASK_SKILL_DIR,
  taskSkillProcessEnv,
  writeTaskSkillFiles,
  writeTaskSkillMarkdown,
} from '../../src/gateway/tasks/skill-files.js';
import { findRepoRoot } from '../../src/install/layout.js';

test('isSkillRequest 识别用户级 skill 头', () => {
  assert.equal(isSkillRequest({ 'x-linkagent-skill': '1' }), true);
  assert.equal(isSkillRequest({}), false);
});

test('identityForLoginTask 固定 web + 登录用户名，tokenKind=personal', () => {
  const id = identityForLoginTask({
    baseUrl: 'http://127.0.0.1:8787/',
    username: 'alice',
    taskId: 't_1',
    taskKey: 'k_abc',
    token: 'pat_x',
  });
  assert.equal(id.channel, 'web');
  assert.equal(id.userId, 'alice');
  assert.equal(id.ownerUsername, 'alice');
  assert.equal(id.tokenKind, 'personal');
  assert.equal(id.baseUrl, 'http://127.0.0.1:8787');
});

test('ensureLoginSpace 只给默认任务写 SKILL.md，凭据走 env 不落盘 identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  const tokens = new Map<string, string>([['alice', 'pat_alice']]);
  const markdown = readTaskSkillMarkdown(findRepoRoot()) ?? '# test\n';
  const svc = new TaskService({
    store: createJsonStore(mkdtempSync(join(tmpdir(), 'st-'))),
    workspaceRoot: root,
    skill: {
      markdown,
      baseUrl: 'http://127.0.0.1:8787',
      personalTokenFor: (u) => tokens.get(u),
    },
  });
  const space = svc.ensureLoginSpace('alice');
  const cwd = space.tasks[0]?.cwd;
  assert.ok(cwd);
  const skillPath = join(cwd, TASK_SKILL_DIR, 'SKILL.md');
  const identPath = join(cwd, '.linkagent', 'identity.json');
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(identPath), false);
  assert.match(readFileSync(skillPath, 'utf8'), /LINKAGENT_TOKEN/);
  const env = svc.skillEnvForTask(space, 'default');
  assert.equal(env?.LINKAGENT_CHANNEL, 'web');
  assert.equal(env?.LINKAGENT_USER_ID, 'alice');
  assert.equal(env?.LINKAGENT_TOKEN, 'pat_alice');
  const extra = svc.createTask(space, '执行任务', 'pi', undefined, undefined, 'node-1');
  assert.equal(svc.skillEnvForTask(space, extra.id), undefined);
  assert.equal(existsSync(join(extra.cwd!, TASK_SKILL_DIR, 'SKILL.md')), false);
});

test('X-LinkAgent-Skill + 网关 token 类凭据 → 403；personal 放行', async () => {
  const svc = new TaskService({ store: createJsonStore(mkdtempSync(join(tmpdir(), 'st-'))) });
  svc.ensureLoginSpace('alice');
  const app = Fastify();
  registerTaskApi(
    app,
    svc,
    () => true,
    {
      sessionUser: () => ({ username: 'alice' }),
      isAdmin: () => false,
      skillAuth: (req) => (isSkillRequest(req.headers) ? 'forbidden' : 'ok'),
    },
  );
  await app.ready();
  try {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/tasks/all',
      headers: { 'x-linkagent-skill': '1' },
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('writeTaskSkillFiles 落盘', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
  writeTaskSkillFiles(cwd, '# skill\n', identityForLoginTask({
    baseUrl: 'http://x',
    username: 'u',
    taskId: 'default',
    taskKey: 'k_1',
    token: 'pat_1',
  }));
  assert.equal(existsSync(join(cwd, TASK_SKILL_DIR, 'SKILL.md')), true);
});

test('writeTaskSkillMarkdown 写到 .agents/skills，并删掉旧的 .skills 副本', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
  const legacy = join(cwd, '.skills', 'linkagent-tasks');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'SKILL.md'), '# old\n');
  writeTaskSkillMarkdown(cwd, '# skill\n');
  assert.equal(existsSync(join(cwd, '.agents', 'skills', 'linkagent-tasks', 'SKILL.md')), true);
  assert.equal(existsSync(legacy), false);
});

test('taskSkillProcessEnv 映射 LINKAGENT_*', () => {
  const env = taskSkillProcessEnv(identityForLoginTask({
    baseUrl: 'http://127.0.0.1:8787/',
    username: 'bob',
    taskId: 'default',
    taskKey: 'k_x',
    token: 'pat_bob',
  }));
  assert.equal(env.LINKAGENT_BASE_URL, 'http://127.0.0.1:8787');
  assert.equal(env.LINKAGENT_USER_ID, 'bob');
  assert.equal(env.LINKAGENT_TOKEN, 'pat_bob');
  assert.equal(env.LINKAGENT_TASK_ID, 'default');
});

test('decideTaskRouting 仅默认任务带 LINKAGENT_* env', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  const svc = new TaskService({
    store: createJsonStore(mkdtempSync(join(tmpdir(), 'st-'))),
    workspaceRoot: root,
    skill: {
      markdown: '# t\n',
      baseUrl: 'http://gw',
      personalTokenFor: () => 'pat_r',
    },
  });
  svc.ensureLoginSpace('carol');
  const d = decideTaskRouting(svc, {
    text: '列出任务',
    channel: 'web',
    userId: 'carol',
    ownerUsername: 'carol',
  });
  assert.equal(d.kind, 'chat');
  if (d.kind === 'chat') {
    assert.equal(d.taskId, 'default');
    assert.equal(d.env?.LINKAGENT_TOKEN, 'pat_r');
    assert.equal(d.env?.LINKAGENT_USER_ID, 'carol');
  }
});
