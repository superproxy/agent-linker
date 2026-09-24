import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateConfig, defaultSharedConfig, defaultAgentDefinitions } from '@linkagent/shared';
import {
  loadSharedConfig,
  resolveGatewayAuth,
  resolveChildRuntime,
  deriveGatewayBase,
  loopbackHost,
  ensureGatewayTokenFile,
  readGatewayTokenFile,
  persistEnsureWeixinAccount,
  persistRemoveWeixinAccount,
  persistAgentEnabled,
  persistNodeAgentRegistered,
} from '../../src/gateway/config.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-cfg-'));
}

function runtimeDirFor(dir: string): string {
  const rt = join(dir, 'runtime-gateway');
  mkdirSync(rt, { recursive: true });
  return rt;
}

function writeConfig(dir: string, content: string, kind: 'dev' | 'dist' = 'dev'): string {
  const cfgDir = kind === 'dist' ? join(dir, 'server', 'config') : join(dir, 'backend', 'config');
  mkdirSync(cfgDir, { recursive: true });
  const file = join(cfgDir, 'gateway.yaml');
  writeFileSync(file, content);
  return file;
}

// ── migrateConfig：旧扁平 → 三段式 ──────────────────────────────────────────

test('migrateConfig：空对象走全缺省（local 鉴权、8787、weixin/node 启用）', () => {
  const cfg = migrateConfig({});
  assert.equal(cfg.gateway.auth.mode, 'local');
  assert.equal(cfg.gateway.server.port, 8787);
  assert.equal(cfg.gateway.server.host, '127.0.0.1');
  assert.equal(cfg.weixin.enabled, true);
  assert.equal(cfg.node.enabled, true);
  assert.equal(cfg.weixin.model, 'agent:pi');
});

test('migrateConfig：旧 auth.enabled=false → open；enabled=true → token', () => {
  const open = migrateConfig({ auth: { enabled: false } });
  assert.equal(open.gateway.auth.mode, 'open');
  const token = migrateConfig({ auth: { enabled: true, token: 'abc' } });
  assert.equal(token.gateway.auth.mode, 'token');
  assert.equal(token.gateway.auth.token, 'abc');
});

test('migrateConfig：显式 mode 优先于 enabled 布尔；都缺省 → local', () => {
  const cfg = migrateConfig({ auth: { enabled: true, mode: 'open' } });
  assert.equal(cfg.gateway.auth.mode, 'open');
  const local = migrateConfig({ auth: { token: 'x' } });
  assert.equal(local.gateway.auth.mode, 'local');
});

test('migrateConfig：旧顶层字段收进 gateway 段；旧 weixin.* 映射到新 weixin 段', () => {
  const cfg = migrateConfig({
    server: { host: '0.0.0.0', port: 9000 },
    defaultCwd: '/tmp/ws',
    tasks: { defaultAgentId: 'pi' },
    weixin: { mode: 'external', accountId: 'acc-1', model: 'agent:pi' },
  });
  assert.equal(cfg.gateway.server.host, '0.0.0.0');
  assert.equal(cfg.gateway.server.port, 9000);
  assert.equal(cfg.gateway.defaultCwd, '/tmp/ws');
  assert.equal(cfg.gateway.tasks.defaultAgentId, 'pi');
  assert.equal(cfg.weixin.mode, 'external');
  assert.equal(cfg.weixin.accountId, 'acc-1');
  assert.equal(cfg.weixin.model, 'agent:pi');
  // 旧扁平无 node 段 → 缺省启用
  assert.equal(cfg.node.enabled, true);
});

test('migrateConfig：已是三段式直接解析，不做二次迁移', () => {
  const cfg = migrateConfig({
    gateway: { server: { host: '127.0.0.1', port: 7000 }, auth: { mode: 'token', token: 'gw-tok' } },
    weixin: { enabled: false },
    node: { enabled: false, name: 'rn' },
  });
  assert.equal(cfg.gateway.server.port, 7000);
  assert.equal(cfg.gateway.auth.mode, 'token');
  assert.equal(cfg.gateway.auth.token, 'gw-tok');
  assert.equal(cfg.weixin.enabled, false);
  assert.equal(cfg.node.enabled, false);
  assert.equal(cfg.node.name, 'rn');
});

test('defaultSharedConfig：内置默认 agent 且 local 鉴权', () => {
  const cfg = defaultSharedConfig();
  assert.equal(cfg.gateway.auth.mode, 'local');
  assert.ok(cfg.gateway.agents.length >= 5);
  assert.deepEqual(
    cfg.gateway.agents.map((a) => a.id),
    ['opencode', 'pi', 'workbuddy', 'trace-cli', 'cursor'],
  );
});

test('defaultAgentDefinitions：pi 不绑死外机模型，沿用本机 pi 默认', () => {
  const pi = defaultAgentDefinitions().find((a) => a.id === 'pi');
  assert.ok(pi);
  assert.equal(pi.model, undefined);
});

// ── loadSharedConfig：文件 / 缺省回退 ───────────────────────────────────────

test('loadSharedConfig：GATEWAY_CONFIG_PATH 指向缺失文件抛错；pathArg 缺失则回退默认+运行时', () => {
  const prev = process.env.GATEWAY_CONFIG_PATH;
  const missing = join(tmpRoot(), 'nope.yaml');
  process.env.GATEWAY_CONFIG_PATH = missing;
  try {
    assert.throws(() => loadSharedConfig(), /配置文件不存在/);
  } finally {
    if (prev === undefined) delete process.env.GATEWAY_CONFIG_PATH;
    else process.env.GATEWAY_CONFIG_PATH = prev;
  }
  const rt = join(tmpRoot(), 'rt');
  const loaded = loadSharedConfig(missing, rt);
  assert.equal(loaded.source, 'defaults');
  assert.equal(loaded.path, missing);
});

test('loadSharedConfig：gateway.yaml 扁平段加载', () => {
  const dir = tmpRoot();
  const file = writeConfig(
    dir,
    `server: { host: 127.0.0.1, port: 8642 }\nauth:\n  mode: open\n`,
  );
  const loaded = loadSharedConfig(file);
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.path, file);
  assert.equal(loaded.mode, 'split');
  assert.equal(loaded.config.gateway.server.port, 8642);
  assert.equal(loaded.config.gateway.auth.mode, 'open');
});

// ── gateway token：配置优先 / 自动生成落盘 / 0600 / 三进程共享 ───────────────

test('resolveGatewayAuth：open 模式 token 置空，不生成文件', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, '.runtime-state', 'gateway-token');
  const cfg = migrateConfig({ gateway: { auth: { mode: 'open' } } });
  const auth = resolveGatewayAuth(cfg, tokenFile);
  assert.equal(auth.mode, 'open');
  assert.equal(auth.token, '');
  assert.equal(existsSync(tokenFile), false);
});

test('resolveGatewayAuth：配置 token 优先，不写文件', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, '.runtime-state', 'gateway-token');
  const cfg = migrateConfig({ gateway: { auth: { mode: 'token', token: 'configured-secret' } } });
  const auth = resolveGatewayAuth(cfg, tokenFile);
  assert.equal(auth.token, 'configured-secret');
  assert.equal(existsSync(tokenFile), false);
});

test('resolveGatewayAuth：local 模式空 token 自动生成落盘（0600），二次读取复用', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, '.runtime-state', 'gateway-token');
  const cfg = migrateConfig({});
  const auth1 = resolveGatewayAuth(cfg, tokenFile);
  assert.equal(auth1.mode, 'local');
  assert.match(auth1.token, /^lg_/);
  assert.equal(existsSync(tokenFile), true);
  // 权限 0600（仅检查 POSIX）
  if (process.platform !== 'win32') {
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  }
  // 另一进程视角：只读拿到同一枚 token
  assert.equal(readGatewayTokenFile(tokenFile), auth1.token);
  // 再次 resolve（配置仍空）复用文件，不重新生成
  const auth2 = resolveGatewayAuth(cfg, tokenFile);
  assert.equal(auth2.token, auth1.token);
});

test('ensureGatewayTokenFile：文件内容为空时重新生成', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, 'gateway-token');
  writeFileSync(tokenFile, '  \n');
  const t = ensureGatewayTokenFile(tokenFile);
  assert.match(t, /^lg_/);
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), t);
});

// ── 子进程回连推导：env > 配置段 > gateway 段推导 ───────────────────────────

test('loopbackHost：0.0.0.0/:: 归一化到 127.0.0.1，其余原样', () => {
  assert.equal(loopbackHost('0.0.0.0'), '127.0.0.1');
  assert.equal(loopbackHost('::'), '127.0.0.1');
  assert.equal(loopbackHost('192.168.1.5'), '192.168.1.5');
});

test('deriveGatewayBase：回环归一化拼接端口', () => {
  const cfg = migrateConfig({ server: { host: '0.0.0.0', port: 9999 } });
  assert.equal(deriveGatewayBase(cfg), 'http://127.0.0.1:9999');
});

test('resolveChildRuntime：env 优先级最高，其次配置段，最后推导', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, 'gateway-token');
  const cfg = migrateConfig({ server: { host: '0.0.0.0', port: 8787 } });
  // 无 env / 段：推导回环 base，token 取文件（不存在→空）
  const derived = resolveChildRuntime(cfg, {}, {}, tokenFile);
  assert.equal(derived.gatewayUrl, 'http://127.0.0.1:8787');
  assert.equal(derived.gatewayToken, '');

  // 配置段优先于推导
  const section = resolveChildRuntime(
    cfg,
    { gatewayUrl: 'http://section:1', gatewayToken: 'section-tok' },
    {},
    tokenFile,
  );
  assert.equal(section.gatewayUrl, 'http://section:1');
  assert.equal(section.gatewayToken, 'section-tok');

  // env 覆盖配置段
  const env = resolveChildRuntime(
    cfg,
    { gatewayUrl: 'http://section:1', gatewayToken: 'section-tok' },
    { url: 'http://env:2', token: 'env-tok' },
    tokenFile,
  );
  assert.equal(env.gatewayUrl, 'http://env:2');
  assert.equal(env.gatewayToken, 'env-tok');
});

test('resolveChildRuntime：token 回退顺序 env > 段 > gateway.auth.token > 隔离 token 文件', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, 'gateway-token');
  // gateway.auth.token 配置
  const cfg1 = migrateConfig({ auth: { enabled: true, token: 'gw-auth-tok' } });
  assert.equal(resolveChildRuntime(cfg1, {}, {}, tokenFile).gatewayToken, 'gw-auth-tok');

  // 段 token 覆盖 gateway.auth.token
  assert.equal(
    resolveChildRuntime(cfg1, { gatewayToken: 'section-tok' }, {}, tokenFile).gatewayToken,
    'section-tok',
  );

  // 都没有 → token 文件（隔离路径，避免读到真实安装布局）
  const cfg2 = migrateConfig({});
  writeFileSync(tokenFile, 'file-tok\n');
  assert.equal(resolveChildRuntime(cfg2, {}, {}, tokenFile).gatewayToken, 'file-tok');
});

test('resolveChildRuntime：回连远程网关时不套用本机 token 文件', () => {
  const dir = tmpRoot();
  const tokenFile = join(dir, 'gateway-token');
  writeFileSync(tokenFile, 'local-file-tok\n');
  const cfg = migrateConfig({ server: { host: '127.0.0.1', port: 8787 }, auth: { enabled: true, token: 'local-auth-tok' } });

  const remote = resolveChildRuntime(
    cfg,
    { gatewayUrl: 'http://216.19.4.113:8787' },
    {},
    tokenFile,
  );
  assert.equal(remote.gatewayUrl, 'http://216.19.4.113:8787');
  assert.equal(remote.gatewayToken, '');

  const remoteEnv = resolveChildRuntime(
    cfg,
    { gatewayUrl: 'http://216.19.4.113:8787' },
    { url: 'ws://216.19.4.113:8787' },
    tokenFile,
  );
  assert.equal(remoteEnv.gatewayToken, '');

  const remoteExplicit = resolveChildRuntime(
    cfg,
    { gatewayUrl: 'http://216.19.4.113:8787', gatewayToken: 'nt_remote' },
    {},
    tokenFile,
  );
  assert.equal(remoteExplicit.gatewayToken, 'nt_remote');

  const local = resolveChildRuntime(cfg, {}, {}, tokenFile);
  assert.equal(local.gatewayToken, 'local-auth-tok');
});

test('parse 往返：三段式 yaml 能被 migrateConfig 正确解析（含 enabled:false）', () => {
  const raw = parse(`
gateway:
  server: { host: 127.0.0.1, port: 8787 }
  auth: { mode: local, token: "" }
weixin:
  enabled: false
node:
  enabled: true
  name: edge-1
`);
  const cfg = migrateConfig(raw);
  assert.equal(cfg.weixin.enabled, false);
  assert.equal(cfg.node.enabled, true);
  assert.equal(cfg.node.name, 'edge-1');
  assert.equal(cfg.gateway.auth.mode, 'local');
});

test('persistEnsureWeixinAccount：写入 overlay accounts 并切 external；remove 去掉该 id', () => {
  const dir = tmpRoot();
  const rt = runtimeDirFor(dir);
  const file = join(dir, 'gateway.yaml');
  writeFileSync(file, 'server:\n  host: 127.0.0.1\n  port: 8787\n');
  writeFileSync(join(dir, 'weixin.yaml'), 'enabled: true\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: false\n');
  writeFileSync(join(dir, 'channels.yaml'), 'channelGateway:\n  enabled: false\n');
  const ids = persistEnsureWeixinAccount(file, 'alice', rt);
  assert.deepEqual(ids, ['alice']);
  let cfg = loadSharedConfig(file, rt).config;
  assert.equal(cfg.weixin.mode, 'external');
  assert.equal(cfg.weixin.enabled, true);
  assert.deepEqual(cfg.weixin.accounts, ['alice']);
  assert.equal(cfg.channelGateway.enabled, true);
  assert.equal(cfg.channelGateway.weixin, true);
  persistEnsureWeixinAccount(file, 'alice', rt);
  persistEnsureWeixinAccount(file, 'bob', rt);
  cfg = loadSharedConfig(file, rt).config;
  assert.deepEqual(cfg.weixin.accounts, ['alice', 'bob']);
  assert.deepEqual(persistRemoveWeixinAccount(file, 'alice', rt), ['bob']);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /accounts:/);
});

test('persistNodeAgentRegistered：追加 node.agents id，不重复', () => {
  const dir = tmpRoot();
  const rt = runtimeDirFor(dir);
  const file = join(dir, 'gateway.yaml');
  writeFileSync(file, 'server:\n  host: 127.0.0.1\n  port: 8787\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: true\nagents:\n  - pi\n');
  persistNodeAgentRegistered(file, 'hermes', rt);
  let cfg = loadSharedConfig(file, rt).config;
  assert.deepEqual(cfg.node.agents.map((a) => (typeof a === 'string' ? a : a.id)), ['pi', 'hermes']);
  persistNodeAgentRegistered(file, 'hermes', rt);
  cfg = loadSharedConfig(file, rt).config;
  assert.deepEqual(cfg.node.agents.map((a) => (typeof a === 'string' ? a : a.id)), ['pi', 'hermes']);
});

test('persistAgentEnabled：写入 overlay agents.enabled，缺 yaml 列表时整表落下', () => {
  const dir = tmpRoot();
  const rt = runtimeDirFor(dir);
  const file = join(dir, 'gateway.yaml');
  writeFileSync(file, 'server:\n  host: 127.0.0.1\n  port: 8787\n');
  const defs = defaultAgentDefinitions();
  persistAgentEnabled(file, 'pi', false, defs, rt);
  let cfg = loadSharedConfig(file, rt).config;
  assert.equal(cfg.gateway.agents.find((a) => a.id === 'pi')?.enabled, false);
  assert.ok(cfg.gateway.agents.some((a) => a.id === 'opencode' && a.enabled !== false));
  persistAgentEnabled(file, 'pi', true, cfg.gateway.agents, rt);
  cfg = loadSharedConfig(file, rt).config;
  assert.equal(cfg.gateway.agents.find((a) => a.id === 'pi')?.enabled, true);
});
