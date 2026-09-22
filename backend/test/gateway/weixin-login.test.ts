/**
 * 微信扫码登录管理 API 测试：验证 accountId 定向重扫透传。
 *
 * 用 stub 顶替真实 openclaw-weixin 插件 service（真实扫码依赖微信服务，不在此测），
 * 只验证 HTTP 层把 body.query 里的 accountId 正确透传给 service 的 startQr / waitQr。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWeixinApi, WeixinLoginService, normalizeQrWait, takeRefreshedQrUrl } from '../../src/gateway/weixin-login.js';

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
      // 模拟插件回写 *-im-bot，与登录账号槽不一致
      return { connected: true, accountId: '51d9f31fb43e-im-bot' };
    },
    hasToken: () => false,
    adoptPluginAccount() {},
  } as unknown as WeixinLoginService;
  return { service, calls };
}

async function appOf() {
  const { service, calls } = buildStub();
  const app = Fastify();
  registerWeixinApi(app, service, () => true);
  return { app, calls };
}

test('takeRefreshedQrUrl：刷新提示和链接分两次写出时仍能拿到新链接', () => {
  const state = { armed: false };
  assert.equal(takeRefreshedQrUrl('普通日志 https://example.com/old\n', state), undefined);
  assert.equal(takeRefreshedQrUrl('🔄 二维码已更新，请重新扫描。\n\n', state), undefined);
  assert.equal(state.armed, true);
  assert.equal(
    takeRefreshedQrUrl('若二维码未能显示，你可以访问以下链接以继续：\nhttps://liteapp.weixin.qq.com/q/abc.\n', state),
    'https://liteapp.weixin.qq.com/q/abc',
  );
  assert.equal(state.armed, false);
});

test('normalizeQrWait：OpenClaw 文案是 bot 已绑定；没有本机 token 不能当成成功', () => {
  const missing = normalizeQrWait({
    connected: false,
    message: '已连接过此 OpenClaw，无需重复连接。',
  });
  assert.equal(missing.connected, false);
  assert.equal(missing.alreadyBound, undefined);
  assert.match(missing.message ?? '', /weixin-bot/);
  assert.match(missing.message ?? '', /没有 token/);

  const reuse = normalizeQrWait(
    { connected: false, message: '已连接过此 OpenClaw，无需重复连接。' },
    { hasLocalToken: true },
  );
  assert.equal(reuse.connected, true);
  assert.equal(reuse.alreadyBound, true);
  assert.match(reuse.message ?? '', /沿用本机登录态/);
  assert.doesNotMatch(reuse.message ?? '', /OpenClaw 渠道/);
});

test('GET /api/weixin/qr/status 机器人已绑定但本机无 token → 不拉起进程', async () => {
  const { service, calls } = buildStub();
  (service as { waitQr: typeof service.waitQr }).waitQr = async (sessionKey, timeoutMs, accountId) => {
    calls.wait.push({ sessionKey, timeoutMs, accountId });
    return { connected: false, message: '已连接过此 OpenClaw，无需重复连接。' };
  };
  (service as { hasToken: (id: string) => boolean }).hasToken = () => false;
  const bound: string[] = [];
  const app = Fastify();
  registerWeixinApi(app, service, () => true, {
    onBound: async (id) => {
      bound.push(id);
    },
  });
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/weixin/qr/status?sessionKey=sk-1&accountId=alice',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { connected: boolean; alreadyBound?: boolean; message?: string };
    assert.equal(body.connected, false);
    assert.equal(body.alreadyBound, undefined);
    assert.match(body.message ?? '', /不走 OpenClaw/);
    assert.deepEqual(bound, []);
  } finally {
    await app.close();
  }
});

test('GET /api/weixin/qr/status 机器人已绑定且本机有 token → 沿用并拉起进程', async () => {
  const { service, calls } = buildStub();
  (service as { waitQr: typeof service.waitQr }).waitQr = async (sessionKey, timeoutMs, accountId) => {
    calls.wait.push({ sessionKey, timeoutMs, accountId });
    return { connected: false, message: '已连接过此 OpenClaw，无需重复连接。' };
  };
  (service as { hasToken: (id: string) => boolean }).hasToken = (id) => id === 'alice';
  const bound: string[] = [];
  const app = Fastify();
  registerWeixinApi(app, service, () => true, {
    onBound: async (id) => {
      bound.push(id);
    },
  });
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/weixin/qr/status?sessionKey=sk-1&accountId=alice',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { connected: boolean; alreadyBound?: boolean; accountId?: string; message?: string };
    assert.equal(body.connected, true);
    assert.equal(body.alreadyBound, true);
    assert.equal(body.accountId, 'alice');
    assert.match(body.message ?? '', /weixin-bot/);
    assert.deepEqual(bound, ['alice']);
  } finally {
    await app.close();
  }
});

test('POST /api/weixin/qr 带 accountId → startQr 收到该账号', async () => {
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
    assert.equal((res.json() as { accountId: string }).accountId, 'acc-1');
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
    assert.equal((await app.inject({ method: 'POST', url: '/api/weixin/unbind', payload: {} })).statusCode, 403);
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
    assert.equal((wait.json() as { accountId: string }).accountId, 'alice');
    assert.deepEqual(bound, ['alice']);
  } finally {
    await app.close();
  }
});

test('扫码已确认但 onBound 失败仍 200，带 boundWarning', async () => {
  const { service } = buildStub();
  const app = Fastify();
  registerWeixinApi(app, service, () => true, {
    onBound: async () => {
      throw new Error('pm restart boom');
    },
  });
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/weixin/qr/status?sessionKey=sk-1&accountId=acc-1',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { connected: boolean; accountId?: string; boundWarning?: string };
    assert.equal(body.connected, true);
    assert.equal(body.accountId, 'acc-1');
    assert.match(body.boundWarning ?? '', /pm restart boom/);
  } finally {
    await app.close();
  }
});

test('POST /api/weixin/unbind：普通用户只能解绑自己，并回调 onUnbound', async () => {
  const { service } = buildStub();
  const seen: string[] = [];
  (service as { unbind: (id: string) => { accountId: string; removed: string[] } }).unbind = (id) => {
    seen.push(`svc:${id}`);
    return { accountId: id, removed: [`${id}.json`] };
  };
  const app = Fastify();
  registerWeixinApi(app, service, () => true, {
    isAdmin: () => false,
    sessionUser: () => ({ username: 'alice' }),
    onUnbound: (id) => {
      seen.push(`cb:${id}`);
    },
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/weixin/unbind',
      payload: { accountId: 'admin' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, ['svc:alice', 'cb:alice']);
    assert.equal((res.json() as { accountId: string }).accountId, 'alice');
  } finally {
    await app.close();
  }
});

test('WeixinLoginService.unbind：删除账号槽登录态且不影响其它账号', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-wx-unbind-'));
  const dir = join(stateDir, 'openclaw-weixin', 'accounts');
  mkdirSync(dir, { recursive: true });
  const acc = (id: string) =>
    JSON.stringify({ token: `tok-${id}`, userId: `wx_${id}`, savedAt: '2026-01-01' });
  writeFileSync(join(dir, 'alice.json'), acc('alice'));
  writeFileSync(join(dir, 'alice.sync.json'), '{}');
  writeFileSync(join(dir, 'alice.context-tokens.json'), '{}');
  writeFileSync(join(dir, 'alice.user-tokens.json'), '{}');
  writeFileSync(join(dir, '51d9f31fb43e-im-bot.user-tokens.json'), '{}');
  writeFileSync(join(dir, 'bob.json'), acc('bob'));
  const svc = new WeixinLoginService({ stateDir });
  assert.equal(svc.status().configured, true);
  writeFileSync(join(dir, '51d9f31fb43e-im-bot.json'), acc('plugin'));
  svc.adoptPluginAccount('carol', '51d9f31fb43e-im-bot');
  assert.equal(existsSync(join(dir, 'carol.json')), true);
  const cache = svc.clearChannelTokenCache('alice');
  assert.deepEqual(cache.removed.sort(), [
    '51d9f31fb43e-im-bot.user-tokens.json',
    'alice.context-tokens.json',
    'alice.user-tokens.json',
  ]);
  assert.equal(existsSync(join(dir, 'alice.json')), true);
  const r = svc.unbind('alice');
  assert.deepEqual(r.removed.sort(), ['alice.json', 'alice.sync.json']);
  assert.equal(existsSync(join(dir, 'alice.json')), false);
  assert.equal(existsSync(join(dir, 'bob.json')), true);
  const left = svc.status().accounts.map((a) => a.id).sort();
  assert.deepEqual(left, ['51d9f31fb43e-im-bot', 'bob', 'carol']);
  assert.throws(() => svc.unbind('../evil'), /非法微信账号槽/);
});
