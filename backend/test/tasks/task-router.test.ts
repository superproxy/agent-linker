import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TaskRouter } from '../../src/channels/task-router.js';

async function withTaskApi(
  handler: (req: { url?: string }, res: import('node:http').ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
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
      const router = new TaskRouter({ gatewayUrl: base, channel: 'weixin' });
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

test('active 无激活任务回落 default，不指定 agent（由网关权威兜底）', async () => {
  await withTaskApi(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ channel: 'weixin', userId: 'wx_1', activeTaskId: '', tasks: [] }));
    },
    async (base) => {
      const router = new TaskRouter({ gatewayUrl: base, channel: 'weixin' });
      const r = await router.active('wx_new');
      assert.equal(r.task, 'default');
      assert.equal(r.agent, undefined);
    },
  );
});

test('resolveToken：按用户携带用户级 token；401 时强制刷新后重试一次', async () => {
  const seen: string[] = [];
  let attempt = 0;
  await withTaskApi(
    (req, res) => {
      // 记录每次请求的 Authorization
      const auth = (req as unknown as { headers: Record<string, string | undefined> }).headers.authorization ?? '';
      seen.push(auth.replace('Bearer ', ''));
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ activeTaskId: 't_9', tasks: [{ id: 't_9', agentId: 'pi' }] }));
    },
    async (base) => {
      const calls: { userId: string; force: boolean }[] = [];
      const router = new TaskRouter({
        gatewayUrl: base,
        channel: 'weixin',
        resolveToken: async (userId, force = false) => {
          calls.push({ userId, force });
          return force ? 'ct_fresh' : 'ct_stale';
        },
      });
      const r = await router.active('wx_user');
      assert.equal(r.task, 't_9');
      assert.equal(r.agent, 'pi');
      // 第一次用旧 token，401 后强制刷新（force=true）再用新 token
      assert.deepEqual(seen, ['ct_stale', 'ct_fresh']);
      assert.deepEqual(calls, [
        { userId: 'wx_user', force: false },
        { userId: 'wx_user', force: true },
      ]);
    },
  );
});

test('带 owner 时查询 web/<owner> 并用网关 token；各联系人共用缓存', async () => {
  const seen: string[] = [];
  await withTaskApi(
    (req, res) => {
      seen.push(req.url ?? '');
      const auth = (req as unknown as { headers: Record<string, string | undefined> }).headers.authorization ?? '';
      seen.push(auth);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ channel: 'web', userId: 'alice', activeTaskId: 't_shared', tasks: [{ id: 't_shared', agentId: 'pi' }] }));
    },
    async (base) => {
      const router = new TaskRouter({
        gatewayUrl: base,
        channel: 'weixin',
        ownerUsername: 'alice',
        gatewayToken: 'gw_static',
        resolveToken: async () => 'ct_peer',
      });
      const r1 = await router.active('wx_1');
      const r2 = await router.active('wx_2');
      assert.equal(r1.task, 't_shared');
      assert.deepEqual(r2, r1);
      assert.equal(seen.filter((s) => s.startsWith('/api/tasks')).length, 1);
      assert.ok(seen[0]?.includes('channel=web'));
      assert.ok(seen[0]?.includes('userId=alice'));
      assert.equal(seen[1], 'Bearer gw_static');
    },
  );
});

test('active 对 HTTP 500 回落 default，不指定 agent（由网关权威兜底）', async () => {
  await withTaskApi(
    (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    },
    async (base) => {
      const router = new TaskRouter({ gatewayUrl: base, channel: 'weixin' });
      const r = await router.active('wx_err');
      assert.equal(r.task, 'default');
      assert.equal(r.agent, undefined);
    },
  );
});
