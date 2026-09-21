/**
 * 微信扫码登录管理 API 测试：验证 accountId 定向重扫透传。
 *
 * 用 stub 顶替真实 openclaw-weixin 插件 service（真实扫码依赖微信服务，不在此测），
 * 只验证 HTTP 层把 body.query 里的 accountId 正确透传给 service 的 startQr / waitQr。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerWeixinApi, WeixinLoginService } from '../../src/gateway/weixin-login.js';

interface StartCall {
  force: boolean | undefined;
  accountId: string | undefined;
}

interface WaitCall {
  sessionKey: string | undefined;
  timeoutMs: number;
  accountId: string | undefined;
}

function buildStub() {
  const calls: { start: StartCall[]; wait: WaitCall[] } = { start: [], wait: [] };
  const service = {
    status: () => ({ configured: false, accounts: [] }),
    async startQr(force = true, accountId?: string) {
      calls.start.push({ force, accountId });
      return { sessionKey: 'sk-1', qrContent: 'login-content' };
    },
    async waitQr(sessionKey?: string, timeoutMs = 8_000, accountId?: string) {
      calls.wait.push({ sessionKey, timeoutMs, accountId });
      return { connected: true, accountId };
    },
  } as unknown as WeixinLoginService;
  return { service, calls };
}

async function appOf() {
  const { service, calls } = buildStub();
  const app = Fastify();
  registerWeixinApi(app, service, () => true);
  return { app, calls };
}

test('POST /api/weixin/qr 带 accountId → startQr 收到定向账号', async () => {
  const { app, calls } = await appOf();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/weixin/qr',
      payload: { force: true, accountId: 'acc-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0]?.accountId, 'acc-1');
    assert.equal(calls.start[0]?.force, true);
  } finally {
    await app.close();
  }
});

test('POST /api/weixin/qr 不带 accountId → startQr 收到 undefined（单账号兼容）', async () => {
  const { app, calls } = await appOf();
  try {
    const res = await app.inject({ method: 'POST', url: '/api/weixin/qr' });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0]?.accountId, undefined);
  } finally {
    await app.close();
  }
});

test('GET /api/weixin/qr/status 带 accountId → waitQr 收到同一账号', async () => {
  const { app, calls } = await appOf();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/weixin/qr/status?sessionKey=sk-1&timeoutMs=5000&accountId=acc-1',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.wait.length, 1);
    assert.equal(calls.wait[0]?.sessionKey, 'sk-1');
    assert.equal(calls.wait[0]?.timeoutMs, 5_000);
    assert.equal(calls.wait[0]?.accountId, 'acc-1');
  } finally {
    await app.close();
  }
});

test('GET /api/weixin/qr/status 不带 accountId → waitQr 收到 undefined', async () => {
  const { app, calls } = await appOf();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/weixin/qr/status?sessionKey=sk-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.wait.length, 1);
    assert.equal(calls.wait[0]?.accountId, undefined);
  } finally {
    await app.close();
  }
});

test('非管理员无登录会话 → 微信接口 403', async () => {
  const { service } = buildStub();
  const app = Fastify();
  registerWeixinApi(app, service, () => true, { isAdmin: () => false });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/weixin/status' })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/weixin/qr', payload: {} })).statusCode, 403);
  } finally {
    await app.close();
  }
});

test('普通用户扫码强制本人账号槽，看不到其他人账号', async () => {
  const { service, calls } = buildStub();
  (service as { status: () => unknown }).status = () => ({
    configured: true,
    accounts: [
      { id: 'alice', userId: 'wx_a' },
      { id: 'admin', userId: 'wx_admin' },
    ],
    activeAccountId: 'admin',
  });
  const bound: string[] = [];
  const app = Fastify();
  registerWeixinApi(app, service, () => true, {
    isAdmin: () => false,
    sessionUser: () => ({ username: 'alice' }),
    onBound: (id) => {
      bound.push(id);
    },
  });
  try {
    const st = await app.inject({ method: 'GET', url: '/api/weixin/status' });
    assert.equal(st.statusCode, 200);
    const body = st.json() as { bindAccountId: string; accounts: { id: string }[]; configured: boolean };
    assert.equal(body.bindAccountId, 'alice');
    assert.deepEqual(body.accounts.map((a) => a.id), ['alice']);

    const qr = await app.inject({
      method: 'POST',
      url: '/api/weixin/qr',
      payload: { accountId: 'admin' },
    });
    assert.equal(qr.statusCode, 200);
    assert.equal(calls.start[0]?.accountId, 'alice');

    const wait = await app.inject({
      method: 'GET',
      url: '/api/weixin/qr/status?sessionKey=sk-1&accountId=admin',
    });
    assert.equal(wait.statusCode, 200);
    assert.equal(calls.wait[0]?.accountId, 'alice');
    assert.deepEqual(bound, ['alice']);
  } finally {
    await app.close();
  }
});
