import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/gateway/index.js';

test('local 模式：回环免登录无需密码，不预创建 admin；非回环首次访问才生成随机密码', async () => {
  const home = mkdtempSync(join(tmpdir(), 'linkagent-local-auth-'));
  process.env.LINKAGENT_HOME = home;
  const built = await buildServer({
    configPath: 'test/fixtures/gateway.local.yaml',
    definitions: [{ id: 'opencode', type: 'opencode', displayName: 'OpenCode' }] as never,
  });
  const { app } = built;
  try {
    const loop = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1' });
    assert.equal(loop.statusCode, 200, loop.body);
    const loopBody = loop.json() as { local?: boolean; user?: { username: string } };
    assert.equal(loopBody.local, true);
    assert.equal(loopBody.user?.username, 'local');
    assert.equal(existsSync(join(home, '.runtime-state', 'users', 'accounts', 'admin.json')), false);

    const stale = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer leftover-session' },
    });
    assert.equal(stale.statusCode, 200);
    assert.equal((stale.json() as { local?: boolean }).local, true);

    const remote = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '10.0.0.8' });
    assert.equal(remote.statusCode, 401);
    const remoteBody = remote.json() as { initialAdmin?: { username: string; password: string } };
    assert.equal(remoteBody.initialAdmin, undefined, '非回环不回传明文密码');
    const pwFile = join(home, '.runtime-state', 'users', 'admin-initial-password');
    assert.equal(existsSync(join(home, '.runtime-state', 'users', 'accounts', 'admin.json')), true);
    assert.equal(existsSync(pwFile), true);

    const password = readFileSync(pwFile, 'utf8').trim();
    const logged = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.0.0.8',
      payload: { username: 'admin', password },
    });
    assert.equal(logged.statusCode, 200, logged.body);

    const again = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1' });
    // 已有 admin 后回环仍免登录为本机用户，不进入登录
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { local?: boolean }).local, true);
  } finally {
    await built.pluginManager?.dispose().catch(() => {});
    await built.manager.dispose().catch(() => {});
    await app.close().catch(() => {});
    delete process.env.LINKAGENT_HOME;
  }
});

after(() => {
  delete process.env.LINKAGENT_HOME;
});
