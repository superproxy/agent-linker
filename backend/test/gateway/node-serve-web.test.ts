import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { nodeSectionSchema } from '@linkagent/shared';
import { renderIdeCompose, serveWebDockerArgs, startNodeServeWeb, type ServeWebChild } from '../../src/node/serve-web.js';

const enabled = {
  enabled: true,
  image: 'codercom/code-server:latest',
  host: '127.0.0.1',
  port: 8000,
  basePath: '/vibe-ide/',
  workspace: '',
};

test('node.serveWeb 缺省关闭', () => {
  const node = nodeSectionSchema.parse({ enabled: true, agents: ['pi'] });
  assert.equal(node.serveWeb.enabled, false);
  assert.equal(node.serveWeb.image, 'codercom/code-server:latest');
  assert.equal(node.serveWeb.port, 8000);
});

test('renderIdeCompose：只发布 code-server 到回环地址', () => {
  const doc = parse(renderIdeCompose(enabled, 'D:/work/repo')) as {
    services: Record<string, { image: string; ports?: string[]; command?: string[] }>;
  };
  assert.equal(doc.services['code-serve-web']?.image, 'codercom/code-server:latest');
  assert.ok(doc.services['code-serve-web']?.command?.includes('--abs-proxy-base-path'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('--trusted-origins'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('*.localhost:8088'));
  assert.ok(doc.services['code-serve-web']?.command?.includes('/root/workspace'));
  assert.deepEqual(doc.services['code-serve-web']?.ports, ['127.0.0.1:8000:8080']);
  assert.match(renderIdeCompose(enabled, 'D:\\work\\repo'), /D:\/work\/repo:\/root\/workspace/);
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
