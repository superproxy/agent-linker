import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/gateway/index.js';
import { decideTaskRouting } from '../../src/gateway/tasks/api.js';

type Built = Awaited<ReturnType<typeof buildServer>>;

/**
 * 用无插件的干净配置构建网关：避免默认 config.yaml 里的 openclaw-weixin 插件
 * 拉起 ilink 长轮询网络句柄，导致测试进程无法退出（process 永不 exit 而挂起）。
 * definitions 覆盖 config.agents，控制台/模型列表等能力不受影响。
 */
/** 集成测试临时状态根目录（after hook 统一清理） */
const TMP_ROOTS: string[] = [];
after(() => {
  for (const root of TMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

async function freshBuilt(definitions: { id: string; type: string; displayName: string; model?: string }[]): Promise<Built> {
  // 状态目录隔离：构建真实网关但把 .runtime-state 指到临时根，避免测试用户（gw_test_* 等）污染真实任务数据
  const stateRoot = mkdtempSync(join(tmpdir(), 'linkagent-gw-'));
  TMP_ROOTS.push(stateRoot);
  return buildServer({
    configPath: 'test/fixtures/gateway.test.yaml',
    definitions: definitions as never,
    stateRoot,
  });
}

test('GET /v1/models 正常（agent 列表）', async () => {
  const built = await freshBuilt([
    { id: 'opencode', type: 'opencode', displayName: 'OpenCode' },
    { id: 'pi', type: 'pi', displayName: 'Pi', model: 'volcengine/deepseek-v4-flash-ga-260731' },
  ]);
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

test('POST /v1 命令分支：/task new 返回文本且不走 agent', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
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

test('集成测试 pi：/task new 建 pi 任务 → 落盘 → 后续消息路由到 pi', async () => {
  const built = await freshBuilt([
    { id: 'opencode', type: 'opencode', displayName: 'OpenCode' },
    { id: 'pi', type: 'pi', displayName: 'Pi', model: 'volcengine/deepseek-v4-flash-ga-260731' },
  ]);
  const { app, manager, pluginManager, taskService } = built;
  try {
    const channel = 'weixin';
    // 唯一 userId：避免跨次运行状态文件残留污染
    const userId = `gw_integ_${Date.now()}`;

    // 1) /task new 集成测试 pi → 命令分支返回文本，绑定 pi
    const created = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'agent:pi',
        channel,
        userId,
        messages: [{ role: 'user', content: '/task new 集成测试 pi' }],
      },
    });
    assert.equal(created.statusCode, 200);
    const createdBody = created.json();
    assert.ok(createdBody.choices[0].message.content.includes('集成测试'));
    assert.ok(createdBody.choices[0].message.content.includes('pi'));

    // 2) 任务已落盘：从网关的 TaskService 重新 load 可见，新建即激活且绑 pi
    const state = taskService.load(channel, userId);
    const task = state.tasks.find((t) => t.name === '集成测试');
    assert.ok(task, '集成测试 任务应已持久化');
    assert.equal(task.agentId, 'pi');
    assert.equal(state.activeTaskId, task.id);

    // 3) 后续普通消息按激活任务路由到 pi，会话 key 编码该任务
    const route = decideTaskRouting(taskService, { text: '继续写集成测试', channel, userId });
    assert.equal(route.kind, 'chat');
    if (route.kind === 'chat') {
      assert.equal(route.agentId, 'pi');
      assert.equal(route.taskId, task.id);
      assert.equal(route.sessionKey, `weixin:${userId}:task:${task.id}`);
    }
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('POST /v1 命令分支 stream=true：SSE 单块返回', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
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
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
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

test('POST /v1 命令分支：未知 agent 路由到 chat 报 404', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, pluginManager } = built;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'agent:opencode',
        channel: 'weixin',
        userId: 'gw_test_3',
        agent: 'nope',
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

test('POST /v1 taskKey 鉴权：停用 key → 403 key_disabled；不存在 → 404', async () => {
  const built = await freshBuilt([{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }]);
  const { app, manager, pluginManager, taskService } = built;
  try {
    const channel = 'weixin';
    const userId = `gw_key_${Date.now()}`;
    const state = taskService.load(channel, userId);
    const t = taskService.createTask(state, '分享任务', 'opencode');
    const send = (taskKey: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'agent:opencode',
          taskKey,
          messages: [{ role: 'user', content: '你好' }],
        },
      });

    // 停用前正常路由到 chat（command 分支不走 agent，这里用普通消息会进 agent，故先只断言非 403/404）
    taskService.setKeyEnabled(state, t.id, false);
    const off = await send(t.key);
    assert.equal(off.statusCode, 403);
    assert.equal(off.json().error.code, 'key_disabled');

    // 不存在 key → 404
    const nf = await send('k_nonexist');
    assert.equal(nf.statusCode, 404);
  } finally {
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
  }
});
