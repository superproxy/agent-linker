import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallLayout, resolveRepoInstallRoot } from '../../src/install/layout.js';

/** 随代码走的内置页面目录：src/install/../dev */
const srcDevDir = join(fileURLToPath(new URL('../../src/install/layout.js', import.meta.url)), '..', '..', 'dev');

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'linkagent-layout-'));
}

test('dev 形态：无 marker 时 kind=dev，配置/入口/页面走 backend 源码布局', () => {
  const root = tmpRoot();
  const layout = createInstallLayout(root);
  assert.equal(layout.kind, 'dev');
  assert.equal(layout.root, root);
  // 配置候选：config/ 优先，legacy server/config、backend/config 兜底
  assert.equal(layout.configCandidates[0], join(root, 'config', 'gateway.yaml'));
  assert.equal(layout.configCandidates[1], join(root, 'server', 'config', 'gateway.yaml'));
  assert.ok(layout.entry('gateway').endsWith(join('backend', 'src', 'gateway', 'index.ts')));
  assert.equal(layout.configFile, layout.configCandidates[0]);
  assert.ok(layout.entry('weixin').endsWith(join('backend', 'src', 'channels', 'weixin-bot.ts')));
  assert.ok(layout.entry('node').endsWith(join('backend', 'src', 'node', 'connector.ts')));
  assert.ok(layout.entry('channels').endsWith(join('backend', 'src', 'channels', 'channel-gateway.ts')));
  // 内置页面随代码走（src/dev），与传入的临时 root 无关
  assert.equal(layout.page('chat'), join(srcDevDir, 'chat.html'));
  assert.ok(existsSync(layout.page('chat')));
  // tsx loader
  assert.ok(layout.tsxLoader.endsWith(join('tsx', 'dist', 'esm', 'index.mjs')));
  // dev 态登录提示含 pnpm 与后台根路径
  assert.match(layout.loginHint, /pnpm/);
  assert.match(layout.loginHint, /后台/);
  assert.match(layout.restartWeixinHint, /pnpm pm restart weixin/);
});

test('dist 形态：有 .linkagent-root 时 kind=dist，配置/入口/页面走产物布局', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  const layout = createInstallLayout(root);
  assert.equal(layout.kind, 'dist');
  assert.equal(layout.configCandidates[0], join(root, 'config', 'gateway.yaml'));
  assert.ok(layout.entry('gateway').endsWith(join('bin', 'gateway.mjs')));
  assert.ok(layout.entry('weixin').endsWith(join('bin', 'weixin.mjs')));
  assert.ok(layout.entry('node').endsWith(join('bin', 'node.mjs')));
  assert.ok(layout.entry('channels').endsWith(join('bin', 'channels.mjs')));
  // 页面随代码走，dist 形态下仍解析到 bundle 旁的 dev 目录（此处仅校验命名规则）
  assert.ok(layout.page('chat').endsWith(join('dev', 'chat.html')));
  // dist 态无 pnpm，只引导后台；重启提示走 start 脚本
  assert.doesNotMatch(layout.loginHint, /pnpm/);
  assert.match(layout.loginHint, /后台/);
  assert.match(layout.restartWeixinHint, /start\.sh restart weixin/);
});

test('configFile：legacy backend/config 存在 gateway.yaml 时 split', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'backend', 'config'), { recursive: true });
  writeFileSync(join(root, 'backend', 'config', 'gateway.yaml'), 'server:\n  port: 8788\n');
  const layout = createInstallLayout(root);
  assert.equal(layout.configMode, 'split');
  assert.equal(layout.configFile, join(root, 'backend', 'config', 'gateway.yaml'));
});

test('configFile：config/ 优先于 legacy backend/config', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'backend', 'config'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'backend', 'config', 'gateway.yaml'), 'server:\n  port: 8788\n');
  writeFileSync(join(root, 'config', 'gateway.yaml'), 'server:\n  port: 8787\n');
  const layout = createInstallLayout(root);
  assert.equal(layout.configFile, join(root, 'config', 'gateway.yaml'));
});

test('configFile：dist 形态选中 config/gateway.yaml', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'gateway.yaml'), 'server:\n  port: 8787\n');
  const layout = createInstallLayout(root);
  assert.equal(layout.configFile, join(root, 'config', 'gateway.yaml'));
});

test('运行态目录：state() 与语义化快捷方式一致', () => {
  const root = tmpRoot();
  const layout = createInstallLayout(root);
  assert.equal(layout.stateRoot, join(root, '.runtime-state'));
  assert.equal(layout.pluginsState, join(root, '.runtime-state', 'plugins'));
  assert.equal(layout.acpxState, join(root, '.runtime-state', 'acpx'));
  assert.equal(layout.nodesState, join(root, '.runtime-state', 'nodes'));
  assert.equal(layout.usersState, join(root, '.runtime-state', 'users'));
  assert.equal(layout.tasksState, join(root, '.runtime-state', 'tasks'));
  assert.equal(layout.tasksWorkspace, join(root, '.runtime-state', 'tasks-workspace'));
  assert.equal(layout.prefsState, join(root, '.runtime-state', 'prefs'));
  assert.equal(layout.nodeState, join(root, '.runtime-state', 'node'));
  assert.equal(layout.pmState, join(root, '.runtime-state', 'pm'));
  assert.equal(layout.pmLogs, join(root, '.runtime-state', 'pm', 'logs'));
  assert.equal(layout.state('a', 'b'), join(root, '.runtime-state', 'a', 'b'));
});

test('webRoot：dist 探测 <root>/web（index.html + assets 齐全才命中）', () => {
  const root = tmpRoot();
  writeFileSync(join(root, '.linkagent-root'), 'marker\n');
  // 缺产物 → undefined
  assert.equal(createInstallLayout(root).webRoot, undefined);
  // 只有 index.html 没有 assets → 仍 undefined
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'index.html'), '<html/>');
  assert.equal(createInstallLayout(root).webRoot, undefined);
  // 补齐 assets → 命中
  mkdirSync(join(root, 'web', 'assets'), { recursive: true });
  assert.equal(createInstallLayout(root).webRoot, join(root, 'web'));
});

test('resolveRepoInstallRoot：.linkagent-server 存在时归 dist/linkagent', () => {
  const repo = tmpRoot();
  mkdirSync(join(repo, 'dist', 'linkagent'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'linkagent', '.linkagent-root'), 'dist\n');
  writeFileSync(join(repo, '.linkagent-server'), 'server\n');
  assert.equal(resolveRepoInstallRoot(repo), join(repo, 'dist', 'linkagent'));
});

test('resolveRepoInstallRoot：LINKAGENT_DEV=1 时仍用仓库根', () => {
  const repo = tmpRoot();
  mkdirSync(join(repo, 'dist', 'linkagent'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'linkagent', '.linkagent-root'), 'dist\n');
  writeFileSync(join(repo, '.linkagent-server'), 'server\n');
  const prev = process.env.LINKAGENT_DEV;
  process.env.LINKAGENT_DEV = '1';
  try {
    assert.equal(resolveRepoInstallRoot(repo), repo);
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_DEV;
    else process.env.LINKAGENT_DEV = prev;
  }
});

test('webRoot：dev 探测 web/dist（vite 产物），而非源码 web/', () => {
  const root = tmpRoot();
  // 源码 web/ 里只有 index.html，没有 assets → 不算产物
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'index.html'), '<html/>');
  assert.equal(createInstallLayout(root).webRoot, undefined);
  // 构建产物 web/dist 齐全 → 命中 dist 目录
  mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<html/>');
  assert.equal(createInstallLayout(root).webRoot, join(root, 'web', 'dist'));
});
