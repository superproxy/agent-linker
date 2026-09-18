import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASE,
  alignToPageOrigin,
  initialGatewayBase,
  isLoopbackAliasPair,
  isLoopbackBase,
  processApiBase,
} from '../../../web/src/lib/local-base.ts';

test('isLoopbackBase：仅回环主机视为本机打开', () => {
  assert.equal(isLoopbackBase('http://127.0.0.1:8787'), true);
  assert.equal(isLoopbackBase('http://localhost:8787'), true);
  assert.equal(isLoopbackBase('http://[::1]:8787'), true);
  assert.equal(isLoopbackBase('http://192.168.1.10:8787'), false);
  assert.equal(isLoopbackBase('http://216.19.4.113:8787'), false);
  assert.equal(isLoopbackBase('not-a-url'), false);
});

test('isLoopbackAliasPair：localhost 与 127.0.0.1 同端口视为别名', () => {
  assert.equal(isLoopbackAliasPair('http://localhost:8787', 'http://127.0.0.1:8787'), true);
  assert.equal(isLoopbackAliasPair('http://127.0.0.1:8787/', 'http://localhost:8787'), true);
  assert.equal(isLoopbackAliasPair('http://localhost:8787', 'http://127.0.0.1:9000'), false);
  assert.equal(isLoopbackAliasPair('http://localhost:8787', 'http://216.19.4.113:8787'), false);
});

test('alignToPageOrigin：回环别名对齐到页面主机，避免跨域', () => {
  assert.equal(alignToPageOrigin('http://localhost:8787', 'http://127.0.0.1:8787'), 'http://localhost:8787');
  assert.equal(alignToPageOrigin('http://127.0.0.1:8787', 'http://localhost:8787'), 'http://127.0.0.1:8787');
  assert.equal(alignToPageOrigin('http://localhost:8787', 'http://216.19.4.113:8787'), 'http://216.19.4.113:8787');
});

test('processApiBase：跟页面部署地址走，本机 127、远程即远程', () => {
  assert.equal(processApiBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(processApiBase('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(processApiBase('http://216.19.4.113:8787'), 'http://216.19.4.113:8787');
  assert.equal(processApiBase(''), DEFAULT_BASE);
});

test('initialGatewayBase：未保存用页面 origin；回环别名对齐；本机 127 不带到远程', () => {
  assert.equal(initialGatewayBase('http://216.19.4.113:8787', null), 'http://216.19.4.113:8787');
  assert.equal(initialGatewayBase('http://localhost:8787', 'http://127.0.0.1:8787'), 'http://localhost:8787');
  assert.equal(initialGatewayBase('http://216.19.4.113:8787', 'http://127.0.0.1:8787'), 'http://216.19.4.113:8787');
  assert.equal(
    initialGatewayBase('http://127.0.0.1:8787', 'http://216.19.4.113:8787'),
    'http://216.19.4.113:8787',
  );
  assert.equal(initialGatewayBase('http://127.0.0.1:8787', 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
