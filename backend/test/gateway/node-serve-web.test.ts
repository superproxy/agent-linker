import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { nodeSectionSchema, LINKAGENT_CODE_SERVER_IMAGE } from '@linkagent/shared';
import { renderIdeCompose, renderWorkspaceFrpc, serveWebDockerArgs, startNodeServeWeb, type ServeWebChild } from '../../src/node/serve-web.js';

const enabled = {
  enabled: true,
  image: LINKAGENT_CODE_SERVER_IMAGE,
  host: '127.0.0.1',
  port: 8000,
  basePath: '/vibe-ide/',
  workspace: '',
};

test('node.serveWeb 缺省关闭', () => {
  const node = nodeSectionSchema.parse({ enabled: true, agents: ['pi'] });
  assert.equal(node.serveWeb.enabled, false);
  assert.equal(node.serveWeb.image, LINKAGENT_CODE_SERVER_IMAGE);
  assert.equal(node.serveWeb.port, 8000);
});

test('renderIdeCompose：只发布 code-server 到回环地址', () => {
  const doc = parse(renderIdeCompose(enabled, 'D:/work/repo')) as {
    services: Record<string, { image: string; ports?: string[]; command?: string[] }>;
  };
  assert.equal(doc.services['code-serve-web']?.image, LINKAGENT_CODE_SERVER_IMAGE);
  assert.ok(doc.services['code-serve-web']?.command?.includes('--abs-proxy-base-path'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('--trusted-origins'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('*.localhost:8088'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('/root/workspace'));
  assert.deepEqual(doc.services['code-serve-web']?.ports, [
    '127.0.0.1:8000:8080',
    '127.0.0.1:5173:5173',
    '127.0.0.1:6080:6080',
  ]);
  assert.match(renderIdeCompose(enabled, 'D:\\work\\repo'), /D:\/work\/repo:\/root\/workspace/);
  assert.match(renderIdeCompose(enabled, 'D:/work/repo'), /linkagent-code-node-modules:\/root\/workspace\/node_modules/);
  assert.equal(doc.services['ide-proxy'], undefined);
});

test('startNodeServeWeb：启用时写 compose 并执行 docker compose up，停止时 down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ide-proxy-'));
  const calls: string[][] = [];
  const child = (): ServeWebChild => ({
    killed: false,
    exitCode: null,
    kill() {
      return true;
    },
    on() {},
  });
  const handle = startNodeServeWeb(
    { serveWeb: enabled, workspaceDir: 'D:/work/repo', runtimeDir: dir },
    (_command, args) => {
      calls.push(args);
      return child();
    },
  );
  assert.deepEqual(calls[0], serveWebDockerArgs(join(dir, 'compose.yml'), 'up'));
  const compose = readFileSync(join(dir, 'compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:8000:8080/);
  assert.doesNotMatch(compose, /nginx/);
  handle.stop();
  assert.deepEqual(calls[1], serveWebDockerArgs(join(dir, 'compose.yml'), 'down'));
});

test('renderWorkspaceFrpc：dev 与 VNC 都登记到 frps', () => {
  const text = renderWorkspaceFrpc('abc');
  assert.match(text, /serverAddr = "host\.docker\.internal"/);
  assert.match(text, /customDomains = \["dev\.localhost"\]/);
  assert.match(text, /customDomains = \["vnc\.localhost"\]/);
  assert.match(text, /localPort = 5173/);
  assert.match(text, /localPort = 6080/);
  assert.throws(() => renderWorkspaceFrpc(''), /无效/);
});

test('startNodeServeWeb：有 frps 令牌时挂上 frpc 配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ide-proxy-'));
  writeFileSync(join(dir, 'frps.token'), 'abc\n');
  startNodeServeWeb(
    { serveWeb: enabled, workspaceDir: 'D:/work/repo', runtimeDir: dir, frpsTokenFile: join(dir, 'frps.token') },
    () => ({ killed: false, exitCode: null, kill: () => true, on() {} }),
  );
  const compose = readFileSync(join(dir, 'compose.yml'), 'utf8');
  const frpc = readFileSync(join(dir, 'frpc.toml'), 'utf8');
  assert.match(compose, /frpc\.toml:\/etc\/linkagent\/frpc\.toml:ro/);
  assert.match(frpc, /name = "workspace-dev"/);
  assert.match(frpc, /name = "workspace-vnc"/);
});

test('startNodeServeWeb：未启用时不调用 docker', () => {
  let called = false;
  startNodeServeWeb(
    {
      serveWeb: { ...enabled, enabled: false },
      workspaceDir: 'D:/work/repo',
      runtimeDir: 'unused',
    },
    () => {
      called = true;
      throw new Error('不应调用');
    },
  );
  assert.equal(called, false);
});
