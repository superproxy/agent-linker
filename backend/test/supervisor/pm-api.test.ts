import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackIp, normalizeTargets } from '../../src/gateway/pm/api.js';

test('isLoopbackIp：仅回环地址判为本机，局域网/代理地址/空值判为远程', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true);
  assert.equal(isLoopbackIp('::1'), true);
  assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackIp('192.168.1.10'), false);
  assert.equal(isLoopbackIp('10.0.0.5'), false);
  assert.equal(isLoopbackIp('0.0.0.0'), false);
  assert.equal(isLoopbackIp(undefined), false);
  assert.equal(isLoopbackIp(''), false);
});

test('normalizeTargets：白名单校验、去重、非字符串拒绝', () => {
  assert.deepEqual(normalizeTargets(['weixin', 'node']), ['weixin', 'node']);
  assert.deepEqual(normalizeTargets('weixin'), ['weixin']);
  assert.deepEqual(normalizeTargets(['weixin', 'weixin', 'node']), ['weixin', 'node']);
  assert.throws(() => normalizeTargets(['nginx']), /未知进程/);
  assert.throws(() => normalizeTargets([123]), /字符串数组/);
  assert.throws(() => normalizeTargets([]), /不能为空/);
});

test('normalizeTargets：默认禁止 gateway 启停，allowGateway 时放行', () => {
  assert.throws(() => normalizeTargets(['gateway']), /仅可重启/);
  assert.deepEqual(normalizeTargets(['gateway'], { allowGateway: true }), ['gateway']);
  assert.deepEqual(normalizeTargets(['gateway', 'weixin'], { allowGateway: true }), ['gateway', 'weixin']);
});
