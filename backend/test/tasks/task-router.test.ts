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
