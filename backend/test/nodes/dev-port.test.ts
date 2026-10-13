import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pickFreePort, readDevPortState, writeDevPortState } from '../../src/node/dev-port.js';
import { getSaasDevTargetPort, setSaasDevTargetPort } from '../../src/node/saas-path.js';
import { buildHostDevPowerShellBody } from '../../src/node/host-dev.js';

test('pickFreePort：LINKAGENT_DEV_FIXED_PORT 优先', async () => {
  const port = await pickFreePort();
  const prev = process.env.LINKAGENT_DEV_FIXED_PORT;
  process.env.LINKAGENT_DEV_FIXED_PORT = String(port);
  try {
    assert.equal(await pickFreePort(), port);
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_DEV_FIXED_PORT;
    else process.env.LINKAGENT_DEV_FIXED_PORT = prev;
  }
});

test('pickFreePort：可立即 bind', async () => {
  const port = await pickFreePort();
  assert.ok(port > 0 && port <= 65535);
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      s.close(() => resolve());
    });
  });
});

test('dev-port.json 读写与 setSaasDevTargetPort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-port-'));
  writeDevPortState(dir, {
    taskId: 't_x',
    port: 52001,
    listen: '127.0.0.1',
    adapterPort: 15173,
    updatedAt: 1,
  });
  const saved = readDevPortState(dir);
  assert.equal(saved?.port, 52001);
  setSaasDevTargetPort(52001);
  assert.equal(getSaasDevTargetPort(), 52001);
});

test('host dev PowerShell 路径模式不注入 base（15173 rewrite）', () => {
  const body = buildHostDevPowerShellBody('t_abc', 52344, 'ide.localhost', true);
  assert.match(body, /52344/);
  assert.match(body, /--host 127\.0\.0\.1/);
  assert.doesNotMatch(body, /--base/);
  assert.doesNotMatch(body, /strictPort/);
  assert.doesNotMatch(body, /allowedHosts/);
});
