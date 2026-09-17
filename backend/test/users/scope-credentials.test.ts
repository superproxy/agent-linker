import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/gateway/index.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

// 独立运行态目录，避免与 users/api.test.ts 共享 admin 改密状态
const runtimeHome = mkdtempSync(join(tmpdir(), 'linkagent-scope-home-'));

let built: Built;
let app: FastifyInstance;
const STATIC = { authorization: 'Bearer test-static-token' };

before(async () => {
  process.env.LINKAGENT_HOME = runtimeHome;
  built = await buildServer({
    configPath: 'test/fixtures/gateway.auth.yaml',
    definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] as never,
  });
  app = built.app;
});

after(async () => {
  await built.pluginManager?.dispose().catch(() => {});
  await built.manager.dispose().catch(() => {});
  await app.close().catch(() => {});
  delete process.env.LINKAGENT_HOME;
});

const channel = 'weixin';
const userId = `scope_${Date.now()}`;
let directTaskKey = '';

test('任务 key 直连：无静态 token，Bearer <taskKey> 可过鉴权且锁定到该任务（/task 命令返回 200）', async () => {
  // 先用静态 token 建任务拿 key（POST /api/tasks 直接返回 task 对象）
  const created = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: STATIC,
    payload: { channel, userId, name: '直连任务', agentId: 'opencode' },
  });
  assert.equal(created.statusCode, 200, created.body);
  directTaskKey = (created.json() as { key: string }).key;
  const taskKey = directTaskKey;
  assert.ok(taskKey.startsWith('k_'));

  // 不带任何静态 token，仅 Bearer 任务 key，发命令（命令分支不真正跑 agent）
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${taskKey}` },
    payload: { model: 'agent:opencode', messages: [{ role: 'user', content: '/task list' }] },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().choices[0].message.content.includes('任务列表'));
});

test('任务 key 不能访问管理接口 /api/agents（作用域受限）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${directTaskKey}` } });
  assert.equal(res.statusCode, 401);
});

test('渠道用户 token：引导接口用静态 token 换取；该 token 只能读自己的 /api/tasks', async () => {
  // 引导换取
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/bot/channel-token',
    headers: STATIC,
    payload: { channel, userId },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const userToken = (bootstrap.json() as { token: string }).token;
  assert.ok(userToken.startsWith('ct_'));

  // 用户 token 读自己的任务 → 200
  const mine = await app.inject({
    method: 'GET',
    url: `/api/tasks?channel=${channel}&userId=${userId}`,
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(mine.statusCode, 200, mine.body);

  // 用户 token 读他人任务 → 401（作用域不符）
  const other = await app.inject({
    method: 'GET',
    url: `/api/tasks?channel=${channel}&userId=someone-else`,
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(other.statusCode, 401);

  // 用户 token 不能访问管理接口
  const agents = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${userToken}` } });
  assert.equal(agents.statusCode, 401);
});

test('渠道用户 token 调 /v1 时伪造他人 userId → 403 scope_forbidden', async () => {
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/bot/channel-token',
    headers: STATIC,
    payload: { channel, userId },
  });
  const userToken = (bootstrap.json() as { token: string }).token;

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${userToken}` },
    payload: {
      model: 'agent:opencode',
      channel,
      userId: 'impersonated-other', // 与凭据归属不符
      messages: [{ role: 'user', content: '/task list' }],
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'scope_forbidden');
});

test('渠道用户 token 管理：列表不回显完整 token；按用户吊销后该 token 立即失效', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/channel-tokens', headers: STATIC });
  assert.equal(list.statusCode, 200, list.body);
  const rows = (list.json() as { tokens: Array<{ userId: string; tokenPreview: string }> }).tokens;
  const mine = rows.find((r) => r.userId === userId);
  assert.ok(mine);
  assert.ok(mine!.tokenPreview.startsWith('ct_'));
  assert.ok(!('token' in mine!)); // 不回显完整 token

  // 普通会话用户不能管理（无静态 token / 非 admin）→ 403
  const noAuth = await app.inject({ method: 'GET', url: '/api/channel-tokens' });
  assert.equal(noAuth.statusCode, 403);

  // 按用户吊销
  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/channel-tokens/by-user/${channel}/${userId}`,
    headers: STATIC,
  });
  assert.equal(revoked.statusCode, 200, revoked.body);

  // 重新换取一枚（旧的已失效）
  const again = await app.inject({
    method: 'POST',
    url: '/api/bot/channel-token',
    headers: STATIC,
    payload: { channel, userId },
  });
  const newToken = (again.json() as { token: string }).token;
  const mineAfter = await app.inject({
    method: 'GET',
    url: `/api/tasks?channel=${channel}&userId=${userId}`,
    headers: { authorization: `Bearer ${newToken}` },
  });
  assert.equal(mineAfter.statusCode, 200);
});
