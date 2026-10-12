import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { nodeSectionSchema, LINKAGENT_CODE_SERVER_IMAGE } from '@linkagent/shared';
import { adapterResponseHeaders, rewriteSaasLocalPath, rewriteSaasRedirect } from '../../src/node/saas-path.js';
import { frpcToken, nodeServeWebSuppressed, publishSaasFrpc, renderIdeCompose, renderSaasWorkspaceFrpc, renderWorkspaceFrpc, serveWebDockerArgs, startNodeServeWeb, type ServeWebChild } from '../../src/node/serve-web.js';
import { renderEmbeddedHttpFrpc } from '../../../code-server/render-frpc.mjs';

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
  assert.deepEqual(node.taskProcesses, []);
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
  assert.ok(doc.services['code-serve-web']?.command?.includes('*.localhost:9080'));
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

test('renderWorkspaceFrpc：ide、dev 与 VNC 都登记到 frps', () => {
  const text = renderWorkspaceFrpc('abc');
  assert.match(text, /serverAddr = "host\.docker\.internal"/);
  assert.match(text, /customDomains = \["ide\.localhost"\]/);
  assert.match(text, /customDomains = \["dev\.localhost"\]/);
  assert.match(text, /customDomains = \["vnc\.localhost"\]/);
  assert.match(text, /localPort = 8080/);
  assert.match(text, /localPort = 5173/);
  assert.match(text, /localPort = 6080/);
  assert.throws(() => renderWorkspaceFrpc(''), /无效/);
});

test('renderSaasWorkspaceFrpc：同一公网域名，路径分开', () => {
  const text = renderSaasWorkspaceFrpc('abc', {
    publicHost: 'hubide.ljyd.cn',
    taskId: 't_41db7238',
    serverAddr: '150.5.140.64',
    serverPort: 7000,
  });
  assert.match(text, /serverAddr = "150\.5\.140\.64"/);
  assert.equal(text.match(/customDomains = \["hubide\.ljyd\.cn"\]/g)?.length, 3);
  assert.match(text, /locations = \["\/t_41db7238", "\/t_41db7238-web"\]/);
  assert.match(text, /locations = \["\/t_41db7238-code"\]/);
  assert.match(text, /locations = \["\/t_41db7238-vnc"\]/);
  assert.match(text, /localPort = 15173/);
  assert.match(text, /localPort = 18080/);
  assert.match(text, /localPort = 16080/);
  assert.doesNotMatch(text, /localhost/);
  assert.equal(rewriteSaasLocalPath('dev', 't_41db7238', '/t_41db7238-web/@vite/client'), '/t_41db7238/@vite/client');
  assert.equal(rewriteSaasLocalPath('dev', 't_41db7238', '/t_41db7238/'), '/t_41db7238/');
  assert.equal(rewriteSaasLocalPath('code', 't_41db7238', '/t_41db7238-code/?folder=/root/workspace'), '/?folder=/root/workspace');
  assert.equal(rewriteSaasLocalPath('vnc', 't_41db7238', '/t_41db7238-vnc/vnc.html'), '/vnc.html');
  const headers = adapterResponseHeaders(
    { 'content-type': 'text/javascript', 'transfer-encoding': 'chunked', connection: 'keep-alive' },
    8,
  );
  assert.equal(headers['content-type'], 'text/javascript');
  assert.equal(headers['content-length'], '8');
  assert.equal(headers['transfer-encoding'], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(
    rewriteSaasRedirect('code', 't_41db7238', '/t_41db7238-code', './?folder=/root/workspace'),
    '/t_41db7238-code/?folder=/root/workspace',
  );
  assert.equal(
    rewriteSaasRedirect('code', 't_41db7238', '/t_41db7238-code/', './?folder=/root/workspace'),
    '/t_41db7238-code/?folder=/root/workspace',
  );
  assert.equal(rewriteSaasRedirect('code', 't_41db7238', '/t_41db7238-code', '/stable/app.js'), '/t_41db7238-code/stable/app.js');
  assert.throws(() => renderSaasWorkspaceFrpc('abc', { publicHost: 'dev.localhost', taskId: 't_1' }), /公网域名无效/);
  assert.throws(() => renderSaasWorkspaceFrpc('abc', { publicHost: 'hubide.ljyd.cn', taskId: 'a/b' }), /taskId 无效/);
});

test('frpcToken：nt_ 不能当作 frpc 加密令牌', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frpc-token-'));
  const file = join(dir, 'frps.token');
  writeFileSync(file, 'nt_abc\n', 'utf8');
  const prev = process.env.FRPS_TOKEN;
  delete process.env.FRPS_TOKEN;
  try {
    assert.equal(frpcToken(file), '');
    process.env.FRPS_TOKEN = 'server-token';
    assert.equal(frpcToken(undefined), 'server-token');
    assert.equal(frpcToken(file), 'server-token');
  } finally {
    if (prev === undefined) delete process.env.FRPS_TOKEN;
    else process.env.FRPS_TOKEN = prev;
  }
});

test('publishSaasFrpc：按任务改写路径，本机域名不改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-frpc-'));
  const file = join(dir, 'frpc.toml');
  writeFileSync(file, 'auth.token = "abc"\nserverAddr = "10.0.0.8"\n', 'utf8');
  const prevHost = process.env.LINKAGENT_PUBLIC_HOST;
  const prevAddr = process.env.FRPS_SERVER_ADDR;
  const prevPort = process.env.FRPS_SERVER_PORT;
  process.env.LINKAGENT_PUBLIC_HOST = 'hubide.ljyd.cn';
  process.env.FRPS_SERVER_ADDR = '150.5.140.64';
  process.env.FRPS_SERVER_PORT = '7000';
  try {
    publishSaasFrpc('t_41db7238', file);
  } finally {
    if (prevHost === undefined) delete process.env.LINKAGENT_PUBLIC_HOST;
    else process.env.LINKAGENT_PUBLIC_HOST = prevHost;
    if (prevAddr === undefined) delete process.env.FRPS_SERVER_ADDR;
    else process.env.FRPS_SERVER_ADDR = prevAddr;
    if (prevPort === undefined) delete process.env.FRPS_SERVER_PORT;
    else process.env.FRPS_SERVER_PORT = prevPort;
  }
  const text = readFileSync(file, 'utf8');
  assert.match(text, /serverAddr = "150\.5\.140\.64"/);
  assert.match(text, /locations = \["\/t_41db7238-code"\]/);
  assert.doesNotMatch(text, /localhost/);
  process.env.LINKAGENT_PUBLIC_HOST = 'dev.localhost';
  writeFileSync(file, 'keep\n', 'utf8');
  publishSaasFrpc('t_41db7238', file);
  assert.equal(readFileSync(file, 'utf8'), 'keep\n');
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
  assert.match(frpc, /name = "workspace-ide"/);
  assert.match(frpc, /name = "workspace-dev"/);
  assert.match(frpc, /name = "workspace-vnc"/);
});

test('startNodeServeWeb：容器内只写 frpc.toml，不再 compose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ide-proxy-'));
  writeFileSync(join(dir, 'frps.token'), 'abc\n');
  const prev = process.env.LINKAGENT_NODE_SERVE_WEB;
  const prevAddr = process.env.FRPS_SERVER_ADDR;
  const prevPort = process.env.FRPS_SERVER_PORT;
  const prevDev = process.env.LINKAGENT_DEV_DOMAIN;
  const prevVnc = process.env.LINKAGENT_VNC_DOMAIN;
  process.env.LINKAGENT_NODE_SERVE_WEB = '0';
  delete process.env.FRPS_SERVER_ADDR;
  delete process.env.FRPS_SERVER_PORT;
  delete process.env.LINKAGENT_DEV_DOMAIN;
  delete process.env.LINKAGENT_VNC_DOMAIN;
  const calls: string[][] = [];
  try {
    startNodeServeWeb(
      {
        serveWeb: { ...enabled, enabled: false },
        workspaceDir: 'D:/work/repo',
        runtimeDir: dir,
        frpsTokenFile: join(dir, 'frps.token'),
        frpcPath: join(dir, 'frpc.toml'),
      },
      (_command, args) => {
        calls.push(args);
        return { killed: false, exitCode: null, kill: () => true, on() {} };
      },
    );
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_NODE_SERVE_WEB;
    else process.env.LINKAGENT_NODE_SERVE_WEB = prev;
    if (prevAddr === undefined) delete process.env.FRPS_SERVER_ADDR;
    else process.env.FRPS_SERVER_ADDR = prevAddr;
    if (prevPort === undefined) delete process.env.FRPS_SERVER_PORT;
    else process.env.FRPS_SERVER_PORT = prevPort;
    if (prevDev === undefined) delete process.env.LINKAGENT_DEV_DOMAIN;
    else process.env.LINKAGENT_DEV_DOMAIN = prevDev;
    if (prevVnc === undefined) delete process.env.LINKAGENT_VNC_DOMAIN;
    else process.env.LINKAGENT_VNC_DOMAIN = prevVnc;
  }
  assert.equal(calls.length, 0);
  const frpc = readFileSync(join(dir, 'frpc.toml'), 'utf8');
  assert.match(frpc, /name = "workspace-vnc"/);
  assert.match(frpc, /serverAddr = "host\.docker\.internal"/);
});

test('nodeServeWebSuppressed：仅 0 / false / off 关闭', () => {
  assert.equal(nodeServeWebSuppressed(undefined), false);
  assert.equal(nodeServeWebSuppressed(''), false);
  assert.equal(nodeServeWebSuppressed('1'), false);
  assert.equal(nodeServeWebSuppressed('0'), true);
  assert.equal(nodeServeWebSuppressed('false'), true);
  assert.equal(nodeServeWebSuppressed('OFF'), true);
});

test('startNodeServeWeb：LINKAGENT_NODE_SERVE_WEB=0 时不 compose', () => {
  const previous = process.env.LINKAGENT_NODE_SERVE_WEB;
  process.env.LINKAGENT_NODE_SERVE_WEB = '0';
  let called = false;
  try {
    startNodeServeWeb(
      { serveWeb: enabled, workspaceDir: 'D:/work/repo', runtimeDir: 'unused' },
      () => {
        called = true;
        throw new Error('不应调用');
      },
    );
  } finally {
    if (previous === undefined) delete process.env.LINKAGENT_NODE_SERVE_WEB;
    else process.env.LINKAGENT_NODE_SERVE_WEB = previous;
  }
  assert.equal(called, false);
});

test('renderEmbeddedHttpFrpc：code-server、dev 与 VNC 三条 HTTP', () => {
  const text = renderEmbeddedHttpFrpc({
    token: 'abc',
    serverAddr: 'frps.example',
    serverPort: 7000,
    ideDomain: 'box-ide.localhost',
    devDomain: 'box-dev.localhost',
    vncDomain: 'box-vnc.localhost',
  });
  assert.match(text, /serverAddr = "frps\.example"/);
  assert.match(text, /localPort = 8080/);
  assert.match(text, /localPort = 5173/);
  assert.match(text, /customDomains = \["box-ide\.localhost"\]/);
  assert.match(text, /customDomains = \["box-dev\.localhost"\]/);
  const withPort = renderEmbeddedHttpFrpc({ token: 'abc', ideDomain: 'ide.localhost:7080', devDomain: 'dev.localhost:7080', vncDomain: 'vnc.localhost:7080' });
  assert.match(withPort, /customDomains = \["ide\.localhost"\]/);
  assert.match(withPort, /customDomains = \["dev\.localhost"\]/);
  assert.match(withPort, /customDomains = \["vnc\.localhost"\]/);
  assert.doesNotMatch(withPort, /:7080/);
  assert.match(text, /localPort = 6080/);
  assert.match(text, /customDomains = \["box-vnc\.localhost"\]/);
  assert.throws(() => renderEmbeddedHttpFrpc({ token: '' }), /无效/);
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
