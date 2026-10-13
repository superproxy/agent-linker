import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FRP_VERSION, NGINX_VERSION, frpAsset, nginxAsset } from '../../src/gateway/edge/assets.js';
import { renderFrpsConf, renderNginxConf } from '../../src/gateway/edge/render.js';
import {
  APISIX_DASHBOARD_PORT,
  TASK_PUBLIC_HOST,
  frpsDashboardRouteSpec,
  renderApisixDashboardConf,
} from '../../src/gateway/edge/apisix.ts';
import {
  dockerComposeExecutable,
  dockerExecutable,
  resolveComposeLauncher,
  startGatewayEdge,
} from '../../src/gateway/edge/runtime.js';
import { apisixComposeArgs } from '../../src/gateway/edge/apisix.js';
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

test('nginx 只监听回环，frps 控制口和面板对外开放', () => {
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
  assert.match(frps, /vhostHTTPPort = 7080/);
  assert.match(frps, /webServer\.addr = "0\.0\.0\.0"/);
  assert.match(frps, /webServer\.port = 7500/);
  const withPlugin = renderFrpsConf({ token: 't', dashboardPassword: 'p', pluginAddr: '127.0.0.1:8787' });
  assert.match(withPlugin, /\[\[httpPlugins\]\]/);
  assert.match(withPlugin, /addr = "127\.0\.0\.1:8787"/);
  assert.match(withPlugin, /path = "\/internal\/frp\/handler"/);
  assert.match(withPlugin, /ops = \["Login"\]/);
  const allowAt = withPlugin.indexOf('allowPorts');
  const pluginAt = withPlugin.indexOf('[[httpPlugins]]');
  assert.ok(allowAt >= 0 && pluginAt >= 0 && allowAt < pluginAt);
});

test('dockerExecutable：PATH 没有 docker 时用 /usr/bin/docker', () => {
  const seen: string[] = [];
  const found = dockerExecutable('linux', { PATH: '/usr/local/bin' }, (path) => {
    seen.push(path);
    return path === '/usr/bin/docker';
  });
  assert.equal(found, '/usr/bin/docker');
  assert.equal(seen.includes('/usr/bin/docker'), true);
});

test('renderApisixDashboardConf：etcd 与登录用户', () => {
  const yaml = renderApisixDashboardConf({
    jwtSecret: 'jwt-secret',
    username: 'admin',
    password: 'dash-pass',
  });
  assert.match(yaml, new RegExp(`port: ${APISIX_DASHBOARD_PORT}`));
  assert.match(yaml, /http:\/\/etcd:2379/);
  assert.match(yaml, /prefix: \/apisix/);
  assert.match(yaml, /username: admin/);
  assert.match(yaml, /password: dash-pass/);
});

test('本机 enhance：frps 面板经 APISIX /frps 反代到 :7500', () => {
  const spec = frpsDashboardRouteSpec('ide.localhost');
  assert.equal(spec.id, 'frps-dashboard');
  assert.equal(spec.host, 'ide.localhost');
  assert.deepEqual(spec.uris, ['/frps', '/frps/', '/frps/*']);
  assert.equal(spec.upstream, 'http://127.0.0.1:7500');
  assert.deepEqual(spec.rewrite, ['^/frps/?(.*)', '/$1']);
  const loop = frpsDashboardRouteSpec('127.0.0.1', 'frps-dashboard-127');
  assert.equal(loop.id, 'frps-dashboard-127');
});

test('没有 compose 插件时退回 docker-compose', () => {
  const launcher = resolveComposeLauncher(
    '/usr/bin/docker',
    'linux',
    { PATH: '/usr/bin' },
    (path) => path === '/usr/bin/docker-compose',
    () => false,
  );
  assert.deepEqual(launcher, { command: '/usr/bin/docker-compose', style: 'standalone' });
  assert.equal(
    dockerComposeExecutable('linux', { PATH: '/opt' }, (path) => path === '/usr/local/bin/docker-compose'),
    '/usr/local/bin/docker-compose',
  );
  assert.deepEqual(apisixComposeArgs('/tmp/c.yml', 'up', 'standalone'), [
    '-p',
    'linkagent-edge',
    '-f',
    '/tmp/c.yml',
    'up',
    '-d',
  ]);
  assert.equal(apisixComposeArgs('/tmp/c.yml', 'up', 'plugin')[0], 'compose');
});

test('同步路由时使用已写入的 admin key，且不拉起进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-'));
  const runtime = join(root, 'runtime');
  let seenKey = '';
  const edge = await startGatewayEdge({
    toolsDir: join(root, 'tools'),
    runtimeDir: runtime,
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8010',
    gatewayUpstream: 'http://127.0.0.1:8787',
    platform: 'freebsd',
    arch: 'x64',
    fetchImpl: () => {
      throw new Error('不应下载');
    },
    adminFetch: async (_input, init) => {
      seenKey = new Headers(init?.headers).get('X-API-KEY') ?? '';
      return new Response('{}', { status: 200 });
    },
  });
  await edge.syncTaskHosts([]);
  const expected = readFileSync(join(runtime, 'apisix.admin-key'), 'utf8').trim();
  assert.ok(expected);
  assert.equal(seenKey, expected);
  edge.stop();
});

test('startGatewayEdge：二进制已在则只写配置，不拉起 frps 与 APISIX', async () => {
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
  const edge = await startGatewayEdge({
    toolsDir: tools,
    runtimeDir: runtime,
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8010',
    gatewayUpstream: 'http://127.0.0.1:8787',
    platform: 'win32',
    arch: 'x64',
    fetchImpl: () => {
      throw new Error('不应下载');
    },
  });
  assert.match(readFileSync(join(runtime, 'frps.toml'), 'utf8'), /bindPort = 7000/);
  assert.match(readFileSync(join(runtime, 'frps.path'), 'utf8'), /frps\.exe/);
  assert.match(readFileSync(join(runtime, 'apisix-config.yaml'), 'utf8'), /admin_key/);
  assert.equal(existsSync(join(runtime, 'apisix-compose.yml')), false);
  assert.match(readFileSync(join(runtime, 'frpc.path'), 'utf8'), /frpc\.exe/);
  edge.stop();
});

test('syncTaskHosts 在正式域名上按 /taskId-type 转发', async () => {
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
  });
  await edge.syncTaskHosts([
    { id: 'default', name: '默认', enabled: true },
    { id: 't_41db7238', name: 'test', enabled: false },
  ]);
  const put = (id: string) => calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/routes/${id}`));
  assert.equal(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/routes/code-localhost')), false);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/code-localhost')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/code-ide')), true);
  assert.match(put('task-open-default')?.body ?? '', /"uris":\["\/default","\/default\/","\/default\/\*"\]/);
  assert.match(put('task-open-default')?.body ?? '', /"pass_host":"pass"/);
  assert.doesNotMatch(put('task-open-default')?.body ?? '', /upstream_host/);
  assert.doesNotMatch(put('task-open-default')?.body ?? '', /proxy-rewrite/);
  assert.match(put('task-open-default')?.body ?? '', /host\.docker\.internal:7080/);
  assert.match(put('task-open-default')?.body ?? '', /"priority":1/);
  assert.match(put('task-default')?.body ?? '', new RegExp(`"host":"${TASK_PUBLIC_HOST}"`));
  assert.match(
    put('task-default')?.body ?? '',
    /"uris":\["\/default-web","\/default-web\/","\/default-web\/\*"\]/,
  );
  assert.match(put('task-default')?.body ?? '', /host\.docker\.internal:7080/);
  assert.match(put('task-default')?.body ?? '', /"pass_host":"pass"/);
  assert.match(put('task-default')?.body ?? '', /"priority":10/);
  assert.match(
    put('task-code-default')?.body ?? '',
    /"uris":\["\/default-code","\/default-code\/","\/default-code\/\*"\]/,
  );
  assert.match(put('task-code-default')?.body ?? '', /host\.docker\.internal:7080/);
  assert.doesNotMatch(put('task-code-default')?.body ?? '', /upstream_host/);
  assert.match(
    put('task-code-t_41db7238')?.body ?? '',
    /"uris":\["\/t_41db7238-code","\/t_41db7238-code\/","\/t_41db7238-code\/\*"\]/,
  );
  assert.match(put('task-code-t_41db7238')?.body ?? '', /"status":0/);
  assert.equal(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/routes/task-dev-default')), false);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-dev-default')), true);
  assert.match(
    put('task-vnc-t_41db7238')?.body ?? '',
    /"uris":\["\/t_41db7238-vnc","\/t_41db7238-vnc\/","\/t_41db7238-vnc\/\*"\]/,
  );
  assert.match(put('task-vnc-t_41db7238')?.body ?? '', /host\.docker\.internal:7080/);
  assert.match(put('task-vnc-t_41db7238')?.body ?? '', /"pass_host":"pass"/);
  assert.doesNotMatch(put('task-vnc-t_41db7238')?.body ?? '', /upstream_host/);
  assert.match(put('task-vnc-t_41db7238')?.body ?? '', /"status":0/);
  assert.match(put('frps-dashboard')?.body ?? '', /"host":"ide\.localhost"/);
  assert.match(put('frps-dashboard')?.body ?? '', /\/frps/);
  assert.match(put('frps-dashboard')?.body ?? '', /host\.docker\.internal:7500/);
  assert.match(put('frps-dashboard-127')?.body ?? '', /"host":"127\.0\.0\.1"/);
  await edge.applyTaskHost({ taskId: 'default', enabled: false, removed: true });
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-open-default')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-default')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-code-default')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-dev-default')), true);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/task-vnc-default')), true);
  edge.stop();
});

test('子域模式：APISIX 登记 *.apex 并去掉 task-* 路径路由', async () => {
  const prevMode = process.env.LINKAGENT_TASK_ROUTING;
  process.env.LINKAGENT_TASK_ROUTING = 'host';
  const root = mkdtempSync(join(tmpdir(), 'edge-host-'));
  const calls: { method: string; url: string; body?: string }[] = [];
  try {
    const edge = await startGatewayEdge({
      toolsDir: join(root, 'tools'),
      runtimeDir: join(root, 'runtime'),
      idePrefix: '/',
      ideUpstream: 'http://127.0.0.1:8010',
      gatewayUpstream: 'http://127.0.0.1:8787',
      publicHost: 'hubide.ljyd.cn',
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
    });
    await edge.syncTaskHosts([{ id: 't_41db7238', name: 'test', enabled: true }]);
    const put = (id: string) => calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/routes/${id}`));
    assert.match(put('task-wildcard-subdomain')?.body ?? '', /"host":"\*\.hubide\.ljyd\.cn"/);
    assert.match(put('task-wildcard-subdomain')?.body ?? '', /host\.docker\.internal:7080/);
    assert.equal(put('task-t_41db7238'), undefined);
    edge.stop();
  } finally {
    if (prevMode === undefined) delete process.env.LINKAGENT_TASK_ROUTING;
    else process.env.LINKAGENT_TASK_ROUTING = prevMode;
  }
});

test('TCP 模式：APISIX 剥路径并指 frps TCP 远端口', async () => {
  const prev = process.env.LINKAGENT_FRPC_MODE;
  process.env.LINKAGENT_FRPC_MODE = 'tcp';
  const root = mkdtempSync(join(tmpdir(), 'edge-tcp-'));
  const calls: { method: string; url: string; body?: string }[] = [];
  try {
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
    });
    await edge.syncTaskHosts([{ id: 'default', name: '默认', enabled: true }]);
    const put = (id: string) => calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/routes/${id}`));
    assert.match(put('task-default')?.body ?? '', /host\.docker\.internal:20001/);
    assert.match(put('task-code-default')?.body ?? '', /host\.docker\.internal:20002/);
    assert.match(put('task-vnc-default')?.body ?? '', /host\.docker\.internal:20003/);
    assert.match(put('task-default')?.body ?? '', /proxy-rewrite/);
    assert.doesNotMatch(put('task-default')?.body ?? '', /upstream_host/);
    assert.doesNotMatch(put('task-default')?.body ?? '', /:7080/);
    edge.stop();
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_FRPC_MODE;
    else process.env.LINKAGENT_FRPC_MODE = prev;
  }
});

test('SaaS 公网域名只校验并原样转到 frps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-saas-'));
  const calls: { method: string; url: string; body?: string }[] = [];
  const edge = await startGatewayEdge({
    toolsDir: join(root, 'tools'),
    runtimeDir: join(root, 'runtime'),
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8010',
    gatewayUpstream: 'http://127.0.0.1:8787',
    publicHost: 'hubide.ljyd.cn',
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
  });
  await edge.syncTaskHosts([{ id: 't_41db7238', name: 'test', enabled: true }]);
  const put = (id: string) => calls.find((call) => call.method === 'PUT' && call.url.endsWith(`/routes/${id}`));
  const open = put('task-open-t_41db7238')?.body ?? '';
  assert.match(open, /"host":"hubide\.ljyd\.cn"/);
  assert.match(open, /"uris":\["\/t_41db7238","\/t_41db7238\/","\/t_41db7238\/\*"\]/);
  assert.match(open, /"pass_host":"pass"/);
  assert.doesNotMatch(open, /upstream_host/);
  assert.doesNotMatch(open, /proxy-rewrite/);
  const code = put('task-code-t_41db7238')?.body ?? '';
  assert.match(code, /"uris":\["\/t_41db7238-code","\/t_41db7238-code\/","\/t_41db7238-code\/\*"\]/);
  assert.doesNotMatch(code, /localhost/);
  assert.equal(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/routes/code-localhost')), false);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/code-localhost')), true);
  assert.equal(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/routes/frps-dashboard')), false);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/routes/frps-dashboard')), true);
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
