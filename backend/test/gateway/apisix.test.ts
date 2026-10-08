import { domainToASCII } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApisixAdmin,
  apisixUpstreamNode,
  renderApisixCompose,
  renderApisixRoute,
  taskCodeRouteId,
  taskCodeServerHost,
  taskRouteHost,
  taskRouteId,
} from '../../src/gateway/edge/apisix.ts';

test('任务路由按任务号生成主机名，回环改写到宿主机', () => {
  assert.equal(taskRouteId('t_41db7238'), 'task-t_41db7238');
  assert.equal(taskRouteHost('默认', 'default'), domainToASCII('默认-default-web.localhost'));
  assert.equal(taskRouteHost('test', 't_41db7238'), 'test-t-41db7238-web.localhost');
  assert.equal(taskCodeRouteId('t_41db7238'), 'task-code-t_41db7238');
  assert.equal(taskCodeServerHost('test', 't_41db7238'), 'test-t-41db7238-ide.localhost');
  assert.equal(apisixUpstreamNode('http://127.0.0.1:8787'), 'host.docker.internal:8787');
  const route = renderApisixRoute({
    id: 'task-default',
    host: 'default-web.localhost',
    upstream: 'http://127.0.0.1:8787',
    enabled: false,
  });
  assert.equal(route.status, 0);
  assert.equal(route.host, 'default-web.localhost');
  assert.equal(route.enable_websocket, true);
  const upstream = route.upstream as { nodes: Record<string, number>; pass_host: string };
  assert.equal(upstream.pass_host, 'pass');
  assert.equal(upstream.nodes['host.docker.internal:8787'], 1);
});

test('compose 把数据面放在 8088，管理面只监听回环', () => {
  const compose = renderApisixCompose();
  assert.match(compose, /127\.0\.0\.1:8088:9080/);
  assert.match(compose, /127\.0\.0\.1:9180:9180/);
  assert.match(compose, /host.docker.internal:host-gateway/);
});

test('Admin API 创建开启的路由，删除不存在的路由视为成功', async () => {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const missing = String(input).endsWith('/gone');
    return new Response(missing ? 'missing' : '{}', { status: missing ? 404 : 200 });
  };
  const admin = new ApisixAdmin('http://127.0.0.1:9180', 'k', fetchImpl);
  await admin.upsert({ id: 'task-default', host: 'default.localhost', upstream: 'http://127.0.0.1:8787', enabled: true });
  await admin.remove('gone');
  assert.equal(calls[0]?.method, 'PUT');
  assert.match(calls[0]?.url ?? '', /\/routes\/task-default$/);
  assert.match(calls[0]?.body ?? '', /"status":1/);
  assert.equal(calls[1]?.method, 'DELETE');
});
