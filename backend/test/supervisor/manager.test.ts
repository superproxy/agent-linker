import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAlive,
  killTree,
  readPid,
  removePid,
  spawnDetached,
  waitDead,
  writePid,
} from '../../src/supervisor/proc.js';
import {
  ProcessManager,
  loadGatewayRuntimeConfig,
  parseTargets,
} from '../../src/supervisor/manager.js';
import { createInstallLayout } from '../../src/install/layout.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-pm-'));
}

test('parseTargets：缺省/all → 三进程；单个目标；非法值抛错', () => {
  assert.deepEqual(parseTargets(), ['gateway', 'weixin', 'node']);
  assert.deepEqual(parseTargets('all'), ['gateway', 'weixin', 'node']);
  assert.deepEqual(parseTargets('weixin'), ['weixin']);
  assert.throws(() => parseTargets('nope'), /未知进程/);
});

test('pid 文件：写入/读取/删除，死 pid 视为不存在', () => {
  const dir = tmpRoot();
  const pidFile = join(dir, 'x.pid');
  assert.equal(readPid(pidFile), null);
  writePid(pidFile, process.pid);
  assert.equal(readPid(pidFile), process.pid);
  // 不存在的 pid
  writePid(pidFile, 999_999_9);
  assert.equal(readPid(pidFile), null);
  // 非法内容
  writeFileSync(pidFile, 'not-a-pid');
  assert.equal(readPid(pidFile), null);
  removePid(pidFile);
  assert.equal(existsSync(pidFile), false);
});

test('spawnDetached + killTree：能拉起子进程并整树停止', async () => {
  const dir = tmpRoot();
  const logFile = join(dir, 'child.log');
  // 一个常驻子进程：spawn 一个 sleep（POSIX）/ ping（Windows 兜底用 node 自循环）
  if (process.platform === 'win32') {
    const child = spawnDetached({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      logFile,
    });
    assert.ok(child.pid);
    assert.equal(isAlive(child.pid!), true);
    await killTree(child.pid!, 'SIGTERM');
    await waitDead(child.pid!, 5_000);
    assert.equal(isAlive(child.pid!), false);
  } else {
    const child = spawnDetached({
      command: 'sleep',
      args: ['30'],
      cwd: dir,
      logFile,
    });
    assert.ok(child.pid);
    assert.equal(isAlive(child.pid!), true);
    await killTree(child.pid!, 'SIGTERM');
    await waitDead(child.pid!, 5_000);
    assert.equal(isAlive(child.pid!), false);
  }
});

test('loadGatewayRuntimeConfig：无配置文件走默认 8787/127.0.0.1，默认 local 鉴权', () => {
  const dir = tmpRoot();
  const cfg = loadGatewayRuntimeConfig(createInstallLayout(dir));
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, '127.0.0.1');
  // 默认 local：需要凭据（本机回环免登录），但 token 文件尚未生成故为空串
  assert.equal(cfg.authEnabled, true);
  assert.equal(cfg.token, '');
  // 三段式默认：weixin/node 均启用
  assert.equal(cfg.shared.weixin.enabled, true);
  assert.equal(cfg.shared.node.enabled, true);
});

test('loadGatewayRuntimeConfig：解析端口/token，0.0.0.0 回连地址归一为 127.0.0.1（旧扁平格式自动迁移）', () => {
  const dir = tmpRoot();
  mkdirSync(join(dir, 'server', 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'server', 'config', 'config.yaml'),
    `server:
  host: 0.0.0.0
  port: 9999
auth:
  enabled: true
  token: secret-token
`,
  );
  const cfg = loadGatewayRuntimeConfig(createInstallLayout(dir));
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.authEnabled, true);
  assert.equal(cfg.token, 'secret-token');
});

test('loadGatewayRuntimeConfig：新三段格式 + open 模式 + 进程 enabled 开关', () => {
  const dir = tmpRoot();
  mkdirSync(join(dir, 'server', 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'server', 'config', 'config.yaml'),
    `gateway:
  server: { host: 127.0.0.1, port: 9000 }
  auth: { mode: open, token: "" }
weixin:
  enabled: false
node:
  enabled: true
  name: runner-1
`,
  );
  const cfg = loadGatewayRuntimeConfig(createInstallLayout(dir));
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.authEnabled, false);
  assert.equal(cfg.token, '');
  assert.equal(cfg.shared.weixin.enabled, false);
  assert.equal(cfg.shared.node.enabled, true);
  assert.equal(cfg.shared.node.name, 'runner-1');
});

test('ProcessManager：dev 形态路径/命令/环境变量正确（无 .linkagent-root）', () => {
  const root = tmpRoot();
  const pm = new ProcessManager(root);
  assert.equal(pm.pidFile('gateway'), join(root, '.runtime-state', 'pm', 'gateway.pid'));
  assert.ok(pm.logFile('weixin').endsWith(join('pm', 'logs', 'weixin.log')));
  // dev 用 node --import tsx 直跑 TS 入口（pid 即真实服务进程，非 .bin/tsx 包装）
  const gw = (pm as unknown as { resolve(id: string): { command: string; args: string[] } }).resolve('gateway');
  assert.equal(gw.command, process.execPath);
  assert.equal(gw.args[0], '--import');
  assert.ok(gw.args[1].endsWith(join('tsx', 'dist', 'esm', 'index.mjs')));
  assert.ok(gw.args[2].endsWith(join('backend', 'src', 'gateway', 'index.ts')));
  // gateway 被强制 external
  const gwEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('gateway');
  assert.equal(gwEnv.LINKAGENT_WEIXIN_MODE, 'external');
});

test('ProcessManager：dist 形态用 node 跑 server/*.mjs；子进程自读共享配置，supervisor 不注入 URL/token', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  mkdirSync(join(root, 'server', 'config'), { recursive: true });
  writeFileSync(
    join(root, 'server', 'config', 'config.yaml'),
    `gateway:
  server: { host: 127.0.0.1, port: 8787 }
  auth: { mode: token, token: abc }
node:
  name: runner-9
`,
  );
  const pm = new ProcessManager(root);
  assert.equal(pm.baseUrl, 'http://127.0.0.1:8787');
  const nodeSpec = (pm as unknown as { resolve(id: string): { command: string; args: string[] } }).resolve('node');
  assert.equal(nodeSpec.command, process.execPath);
  assert.ok(nodeSpec.args[0].endsWith(join('server', 'node.mjs')));
  // 回连 URL/token 由 node/weixin 进程自行读共享配置推导，env 不再注入
  const nodeEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('node');
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_URL, undefined);
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_TOKEN, undefined);
  // node.name 配置段优先（缺省才 node-<hostname>）
  assert.equal(nodeEnv.LINKAGENT_NODE_NAME, 'runner-9');
  const wxEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin');
  assert.equal(wxEnv.LINKAGENT_GATEWAY_TOKEN, undefined);
  // 三目标 dist 入口都解析到 server/*.mjs
  const layout = createInstallLayout(root);
  assert.equal(layout.kind, 'dist');
  for (const id of ['gateway', 'weixin', 'node'] as const) {
    assert.ok(layout.entry(id).endsWith(join('server', `${id}.mjs`)), `${id} 入口应指向 server/${id}.mjs`);
  }
});

test('ProcessManager：isEnabled 读取共享配置段开关（weixin/node 可禁用）', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  mkdirSync(join(root, 'server', 'config'), { recursive: true });
  writeFileSync(
    join(root, 'server', 'config', 'config.yaml'),
    `gateway:
  server: { host: 127.0.0.1, port: 8787 }
weixin:
  enabled: false
node:
  enabled: true
`,
  );
  const pm = new ProcessManager(root);
  assert.equal(pm.isEnabled('gateway'), true);
  assert.equal(pm.isEnabled('weixin'), false);
  assert.equal(pm.isEnabled('node'), true);
});
