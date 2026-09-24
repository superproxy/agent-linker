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
  assert.deepEqual(parseTargets(), ['gateway', 'weixin', 'node']);
  assert.deepEqual(parseTargets('all'), ['gateway', 'weixin', 'node']);
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
  assert.equal(gwEnv.LINKAGENT_WEIXIN_MODE, 'external');
});

test('ProcessManager：dist 形态用 node 跑 server/*.mjs；子进程自读共享配置，supervisor 置空屏蔽 URL/token 环境变量', () => {
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
  // 回连 URL/token 由 node/weixin 进程自行读共享配置推导，env 不再注入；
  // 且显式置空 LINKAGENT_GATEWAY_URL/TOKEN，覆盖父进程继承值，本机进程只认共享 config 或本机推导
  const nodeEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('node');
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_URL, '');
  assert.equal(nodeEnv.LINKAGENT_GATEWAY_TOKEN, '');
  // node.name 配置段优先（缺省才 node-<hostname>）
  assert.equal(nodeEnv.LINKAGENT_NODE_NAME, 'runner-9');
  // 本机节点（supervisor 托管）屏蔽 LINKAGENT_NODE_AGENTS：agent 开通只认 config.node.agents，
  // 覆盖父进程继承值，防止 shell/systemd/docker 环境变量隐式改变上线内容
  assert.equal(nodeEnv.LINKAGENT_NODE_AGENTS, '');
  const wxEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin');
  assert.equal(wxEnv.LINKAGENT_GATEWAY_URL, '');
  assert.equal(wxEnv.LINKAGENT_GATEWAY_TOKEN, '');
  // 三目标 dist 入口都解析到 server/*.mjs
  const layout = createInstallLayout(root);
  assert.equal(layout.kind, 'dist');
  for (const id of ['gateway', 'weixin', 'node'] as const) {
    assert.ok(layout.entry(id).endsWith(join('server', `${id}.mjs`)), `${id} 入口应指向 server/${id}.mjs`);
  }
});

test('ProcessManager：weixin.accounts 多账号 → 每账号一个独立实例（实例展开/pid/log/env 隔离）', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'accounts: [acc-1, acc2]',
  });
  const pm = new ProcessManager(root);
  // 实例展开：gateway → 微信账号实例（按配置顺序）→ node
  assert.deepEqual(pm.allInstanceIds(), ['gateway', 'weixin:acc-1', 'weixin:acc2', 'node']);
  assert.deepEqual(pm.expand(['weixin']), ['weixin:acc-1', 'weixin:acc2']);
  assert.deepEqual(pm.expand(['weixin:acc2']), ['weixin:acc2']);
  assert.deepEqual(pm.expand(['gateway', 'weixin', 'gateway']), ['gateway', 'weixin:acc-1', 'weixin:acc2']);
  // pid/log 文件名按账号隔离；默认单实例沿用旧文件名
  assert.equal(pm.pidFile('weixin:acc-1'), join(root, '.runtime-state', 'pm', 'weixin-acc-1.pid'));
  assert.ok(pm.logFile('weixin:acc2').endsWith(join('pm', 'logs', 'weixin-acc2.log')));
  assert.equal(pm.pidFile('weixin'), join(root, '.runtime-state', 'pm', 'weixin.pid'));
  // 账号实例 env 注入账号 id；默认实例不注入。回连 URL/token 由进程自读共享配置，
  // supervisor 显式置空屏蔽父进程继承的环境变量
  const instEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin:acc2');
  assert.equal(instEnv.LINKAGENT_ACCOUNT_ID, 'acc2');
  assert.equal(instEnv.LINKAGENT_GATEWAY_URL, '');
  assert.equal(instEnv.LINKAGENT_GATEWAY_TOKEN, '');
  const defEnv = (pm as unknown as { envFor(id: string): Record<string, string> }).envFor('weixin');
  assert.equal(defEnv.LINKAGENT_ACCOUNT_ID, undefined);
  assert.equal(defEnv.LINKAGENT_GATEWAY_URL, '');
  assert.equal(defEnv.LINKAGENT_GATEWAY_TOKEN, '');
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

test('ProcessManager：extraWeixinAccounts 与 yaml 合并为多实例', () => {
  const root = tmpRoot();
  writeDistSplit(root, {
    gateway: 'server: { host: 127.0.0.1, port: 8787 }',
    weixin: 'enabled: true\naccounts: []\n',
  });
  const pm = new ProcessManager(root, { extraWeixinAccounts: () => ['alice', 'bob'] });
  assert.deepEqual(pm.allInstanceIds(), ['gateway', 'weixin:alice', 'weixin:bob', 'node']);
  assert.deepEqual(pm.expand(['weixin']), ['weixin:alice', 'weixin:bob']);
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
