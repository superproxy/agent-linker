import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/gateway/index.js';

test('local 模式：按运行模式免登录为本机管理员，不区分访问地址，不预创建 admin', async () => {
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
    const loopBody = loop.json() as { local?: boolean; user?: { username: string; role?: string } };
    assert.equal(loopBody.local, true);
    assert.equal(loopBody.user?.username, 'local');
    assert.equal(loopBody.user?.role, 'admin');
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
    assert.equal(remote.statusCode, 200, remote.body);
    const remoteBody = remote.json() as { local?: boolean; user?: { username: string; role?: string } };
    assert.equal(remoteBody.local, true);
    assert.equal(remoteBody.user?.username, 'local');
    assert.equal(remoteBody.user?.role, 'admin');
    assert.equal(existsSync(join(home, '.runtime-state', 'users', 'accounts', 'admin.json')), false);
    assert.equal(existsSync(join(home, '.runtime-state', 'users', 'admin-initial-password')), false);
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
