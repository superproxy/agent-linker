import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function writeDistSplit(
  root: string,
  parts: { gateway: string; weixin?: string; node?: string },
): void {
  writeFileSync(join(root, '.linkagent-root'), 'test dist root\n');
  const cfgDir = join(root, 'server', 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'gateway.yaml'), parts.gateway);
  if (parts.weixin !== undefined) writeFileSync(join(cfgDir, 'weixin.yaml'), parts.weixin);
  if (parts.node !== undefined) writeFileSync(join(cfgDir, 'node.yaml'), parts.node);
}

test('parseTargets：缺省/all → 三进程；单个目标；weixin:<accountId> 实例；非法值抛错', () => {
  assert.deepEqual(parseTargets(), ['gateway', 'weixin', 'channels', 'node']);
  assert.deepEqual(parseTargets('all'), ['gateway', 'weixin', 'channels', 'node']);
  assert.deepEqual(parseTargets('weixin'), ['weixin']);
  assert.deepEqual(parseTargets('weixin:acc1'), ['weixin:acc1']);
  assert.throws(() => parseTargets('nope'), /未知进程/);
  // 空账号 / 含非白名单字符的账号 id 拒绝
  assert.throws(() => parseTargets('weixin:'), /未知进程/);
  assert.throws(() => parseTargets('weixin:好'), /未知进程/);
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

test('loadGatewayRuntimeConfig：解析端口/token，0.0.0.0 回连地址归一为 127.0.0.1', () => {
  const dir = tmpRoot();
  writeDistSplit(dir, {
    gateway: `server:
  host: 0.0.0.0
  port: 9999
auth:
  enabled: true
  token: secret-token
`,
  });
  const cfg = loadGatewayRuntimeConfig(createInstallLayout(dir));
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.authEnabled, true);
  assert.equal(cfg.token, 'secret-token');
});

test('loadGatewayRuntimeConfig：split 三文件 + open 模式 + 进程 enabled 开关', () => {
  const dir = tmpRoot();
  writeDistSplit(dir, {
    gateway: `server: { host: 127.0.0.1, port: 9000 }
auth: { mode: open, token: "" }
`,
    weixin: 'enabled: false',
    node: `enabled: true
name: runner-1
`,
  });
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
  // Windows 下 --import 只接受 file:// URL，裸盘符绝对路径会触发 ERR_UNSUPPORTED_ESM_URL_SCHEME
  assert.equal(
    gw.args[1],
    pathToFileURL(join(root, 'backend', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
  );
  assert.ok(gw.args[1].startsWith('file:///'));
  assert.ok(gw.args[2].endsWith(join('backend', 'src', 'gateway', 'index.ts')));
  // gateway 被强制 external
  const gwEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('gateway');
  assert.equal(gwEnv.LINKAGENT_WEIXIN_MODE, 'raw');
});

test('ProcessManager：dist 形态用 node 跑 server/*.mjs；子进程自读 node.yaml，supervisor 不注入回连环境变量', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  writeDistSplit(root, {
    gateway: `server: { host: 127.0.0.1, port: 8787 }
auth: { mode: token, token: abc }
`,
    node: 'name: runner-9',
  });
  const pm = new ProcessManager(root);
  assert.equal(pm.baseUrl, 'http://127.0.0.1:8787');
  const nodeSpec = (pm as unknown as { resolve(id: string): { command: string; args: string[] } }).resolve('node');
  assert.equal(nodeSpec.command, process.execPath);
  assert.ok(nodeSpec.args[0].endsWith(join('server', 'node.mjs')));
  // node 进程自己读 node.yaml，supervisor 不再注入回连或 agent 环境变量
  const nodeEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('node');
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_URL, undefined);
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_TOKEN, undefined);
  assert.equal(nodeEnv.LINKAGENT_NODE_NAME, undefined);
  assert.equal(nodeEnv.LINKAGENT_NODE_AGENTS, undefined);
  const wxEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin');
  assert.equal(wxEnv.LINKAGENT_GATEWAY_URL, '');
  assert.equal(wxEnv.LINKAGENT_GATEWAY_TOKEN, '');
  // 三目标 dist 入口都解析到 server/*.mjs
  const layout = createInstallLayout(root);
  assert.equal(layout.kind, 'dist');
  for (const id of ['gateway', 'channels', 'weixin', 'node'] as const) {
    assert.ok(layout.entry(id).endsWith(join('server', `${id}.mjs`)), `${id} 入口应指向 server/${id}.mjs`);
  }
});

test('ProcessManager：weixin.accounts 多账号 → 合并为 channels 进程', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'accounts: [acc-1, acc2]',
  });
  const pm = new ProcessManager(root);
  assert.deepEqual(pm.allInstanceIds(), ['gateway', 'channels', 'node']);
  assert.deepEqual(pm.expand(['weixin']), ['channels']);
  assert.deepEqual(pm.expand(['weixin:acc2']), ['channels']);
  assert.deepEqual(pm.expand(['gateway', 'weixin', 'gateway']), ['gateway', 'channels']);
});

test('ProcessManager：操作 weixin:<账号> 时停掉遗留的默认 weixin 进程', async () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, '.runtime-state', 'pm'), { recursive: true });
  const child = spawnDetached({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: root,
    logFile: join(root, '.runtime-state', 'pm', 'logs', 'weixin.log'),
  });
  assert.ok(child.pid);
  writePid(join(root, '.runtime-state', 'pm', 'weixin.pid'), child.pid);
  const pm = new ProcessManager(root, { extraWeixinAccounts: () => ['alice'] });
  assert.equal(pm.isRunning('weixin'), true);
  await pm.stop(['weixin:alice']);
  assert.equal(isAlive(child.pid), false);
  assert.equal(pm.isRunning('weixin'), false);
});

test('ProcessManager：extraWeixinAccounts 与 yaml 合并后仍走 channels', () => {
  const root = tmpRoot();
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'enabled: true\naccounts: []\n',
  });
  const pm = new ProcessManager(root, { extraWeixinAccounts: () => ['alice', 'bob'] });
  assert.deepEqual(pm.allInstanceIds(), ['gateway', 'channels', 'node']);
  assert.deepEqual(pm.expand(['weixin']), ['channels']);
});

test('ProcessManager：未绑定微信账号时 all 不含微信进程', () => {
  const root = tmpRoot();
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'accounts: []\n',
  });
  const pm = new ProcessManager(root);
  assert.deepEqual(pm.allInstanceIds(), ['gateway', 'node']);
  assert.deepEqual(pm.expand(['weixin']), []);
  const env = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin');
  assert.equal(env.LINKAGENT_ACCOUNT_ID, undefined);
  assert.equal(env.LINKAGENT_GATEWAY_URL, '');
  assert.equal(env.LINKAGENT_GATEWAY_TOKEN, '');
});

test('ProcessManager：isEnabled 读取共享配置段开关（weixin/node 可禁用）', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'enabled: false',
    node: 'enabled: true',
  });
  const pm = new ProcessManager(root);
  assert.equal(pm.isEnabled('gateway'), true);
  assert.equal(pm.isEnabled('weixin'), false);
  assert.equal(pm.isEnabled('node'), true);
});
