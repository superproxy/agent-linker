import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FRP_VERSION, NGINX_VERSION, frpAsset, nginxAsset } from '../../src/gateway/edge/assets.js';
import { renderFrpsConf, renderNginxConf } from '../../src/gateway/edge/render.js';
import { taskCodeServerHost, taskRouteHost } from '../../src/gateway/edge/apisix.ts';
import { startGatewayEdge, type EdgeChild } from '../../src/gateway/edge/runtime.js';
import { renderFrpcConfig } from '../../../nat-tunnel/src/tunnel.js';

test('frp 安装包按平台选择官方发行文件', () => {
  const win = frpAsset('win32', 'x64');
  assert.ok(win);
  assert.equal(
    win.url,
    `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_amd64.zip`,
  );
  assert.equal(win.frpsName, 'frps.exe');
  assert.equal(win.frpcName, 'frpc.exe');
  const linux = frpAsset('linux', 'arm64');
  assert.ok(linux);
  assert.match(linux.url, /linux_arm64\.tar\.gz$/);
  assert.equal(frpAsset('freebsd', 'x64'), null);
});

test('nginx 安装包只覆盖 Windows 二进制', () => {
  const win = nginxAsset('win32');
  assert.ok(win);
  assert.equal(win.url, `https://nginx.org/download/nginx-${NGINX_VERSION}.zip`);
  assert.equal(nginxAsset('linux'), null);
});

test('nginx 只监听回环，frps 控制口对外开放、面板在回环', () => {
  const nginx = renderNginxConf({
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8010',
    gatewayUpstream: 'http://127.0.0.1:8787',
    pidPath: 'D:\\run\\nginx.pid',
  });
  assert.match(nginx, /daemon off;/);
  assert.match(nginx, /listen 127\.0\.0\.1:8088;/);
  assert.match(nginx, /server_name localhost ide\.localhost;/);
  assert.match(nginx, /server_name \*\.localhost;/);
  assert.match(nginx, /location \/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8010;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8787;/);
  assert.match(nginx, /pid D:\/run\/nginx\.pid;/);
  const frps = renderFrpsConf({ token: 't', dashboardPassword: 'p' });
  assert.match(frps, /bindAddr = "0\.0\.0\.0"/);
  assert.match(frps, /bindPort = 7000/);
  assert.match(frps, /webServer\.addr = "127\.0\.0\.1"/);
  assert.match(frps, /webServer\.port = 7500/);
});

test('startGatewayEdge：二进制已在则不下载，并拉起 frps 与 APISIX', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-'));
  const tools = join(root, 'tools');
  const runtime = join(root, 'runtime');
  const frpDir = join(tools, 'frp', `frp_${FRP_VERSION}_windows_amd64`);
  const nginxDir = join(tools, 'nginx', `nginx-${NGINX_VERSION}`);
  mkdirSync(frpDir, { recursive: true });
  mkdirSync(nginxDir, { recursive: true });
  writeFileSync(join(frpDir, 'frps.exe'), '');
  writeFileSync(join(frpDir, 'frpc.exe'), '');
  writeFileSync(join(nginxDir, 'nginx.exe'), '');
  const calls: { command: string; args: string[] }[] = [];
  const child = (): EdgeChild => ({
    kill() {
      return true;
    },
    on() {},
  });
  const edge = await startGatewayEdge({
    toolsDir: tools,
    runtimeDir: runtime,
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8000',
    gatewayUpstream: 'http://127.0.0.1:8787',
    platform: 'win32',
    arch: 'x64',
    fetchImpl: () => {
      throw new Error('不应下载');
    },
    spawnFn: (command, args) => {
      calls.push({ command, args });
      return child();
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.command ?? '', /frps\.exe$/);
  assert.deepEqual(calls[0]?.args, ['-c', join(runtime, 'frps.toml')]);
  assert.equal(calls[1]?.command, 'docker');
  assert.ok(calls[1]?.args.includes('up'));
  assert.match(readFileSync(join(runtime, 'apisix-compose.yml'), 'utf8'), /apache\/apisix/);
  assert.match(readFileSync(join(runtime, 'apisix-compose.yml'), 'utf8'), /127\.0\.0\.1:8088:9080/);
  assert.match(readFileSync(join(runtime, 'frpc.path'), 'utf8'), /frpc\.exe/);
  edge.stop();
});

test('syncTaskHosts 用任务号-ide.localhost 登记 code-server，并去掉固定 ide.localhost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-'));
  const calls: { method: string; url: string; body?: string }[] = [];
  const edge = await startGatewayEdge({
    toolsDir: join(root, 'tools'),
    runtimeDir: join(root, 'runtime'),
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8010',
    gatewayUpstream: 'http://127.0.0.1:8787',
    platform: 'freebsd',
    arch: 'x64',
    adminFetch: async (input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response('{}', { status: 200 });
    },
    spawnFn: () => ({
      kill() {
        return true;
      },
      on() {},
    }),
  });
  await edge.syncTaskHosts([
    { id: 'default', name: '默认', enabled: true },
    { id: 't_41db7238', name: 'test', enabled: false },
  ]);
  const put = (id: string) => calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/routes/${id}`));
  const escapeHost = (host: string) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(put('code-localhost')?.body ?? '', /"host":"localhost"/);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/code-ide')), true);
  assert.match(put('task-default')?.body ?? '', new RegExp(`"host":"${escapeHost(taskRouteHost('默认', 'default'))}"`));
  assert.match(put('task-code-default')?.body ?? '', new RegExp(`"host":"${escapeHost(taskCodeServerHost('默认', 'default'))}"`));
  assert.match(put('task-code-default')?.body ?? '', /host\.docker\.internal:8010/);
  assert.match(put('task-code-t_41db7238')?.body ?? '', /"host":"test-t-41db7238-ide\.localhost"/);
  assert.match(put('task-code-t_41db7238')?.body ?? '', /"status":0/);
  await edge.applyTaskHost({ taskId: 'default', enabled: false, removed: true });
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-default')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-code-default')), true);
  edge.stop();
});

test('nat-tunnel 生成连到 frps 的 frpc 配置', () => {
  const conf = renderFrpcConfig({
    serverAddr: '127.0.0.1',
    serverPort: 7000,
    token: 'secret',
    name: 'ide-8000',
    localHost: '127.0.0.1',
    localPort: 8000,
    remotePort: 18000,
  });
  assert.match(conf, /serverAddr = "127\.0\.0\.1"/);
  assert.match(conf, /localPort = 8000/);
  assert.match(conf, /remotePort = 18000/);
  assert.match(conf, /type = "tcp"/);
  assert.throws(() =>
    renderFrpcConfig({
      serverAddr: '127.0.0.1',
      serverPort: 7000,
      token: 'secret',
      name: 'bad port',
      localHost: '127.0.0.1',
      localPort: 8000,
      remotePort: 80,
    }),
  );
});
