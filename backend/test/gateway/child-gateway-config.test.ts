import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistChildGatewayTarget, loadSharedConfig } from '../../src/gateway/config.js';

test('persistChildGatewayTarget：新三段文件写入 weixin/node 远程网关，保留注释与其他键', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(
    cfgPath,
    [
      '# 顶部注释应保留',
      'gateway:',
      '  server:',
      '    host: 127.0.0.1',
      '    port: 8787',
      'weixin:',
      '  mode: external',
      'node:',
      '  name: n1',
    ].join('\n'),
    'utf8',
  );

  persistChildGatewayTarget(cfgPath, 'weixin', { url: 'http://192.168.1.10:8787/', token: 'tok123' });
  const out = readFileSync(cfgPath, 'utf8');
  assert.match(out, /# 顶部注释应保留/);
  assert.match(out, /gatewayUrl: http:\/\/192\.168\.1\.10:8787/); // 末尾斜杠被归一化
  assert.match(out, /gatewayToken: tok123/);
  assert.match(out, /mode: external/);

  const loaded = loadSharedConfig(cfgPath).config;
  assert.equal(loaded.weixin.gatewayUrl, 'http://192.168.1.10:8787');
  assert.equal(loaded.weixin.gatewayToken, 'tok123');
  assert.equal(loaded.node.gatewayUrl, ''); // node 未设置
});

test('persistChildGatewayTarget：切回本机（空 url）删除两个键；空 token 清除旧 token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(
    cfgPath,
    [
      'node:',
      '  name: n1',
      '  gatewayUrl: https://remote.example.com',
      '  gatewayToken: secret',
    ].join('\n'),
    'utf8',
  );

  persistChildGatewayTarget(cfgPath, 'node', { url: '', token: '' });
  const out = readFileSync(cfgPath, 'utf8');
  assert.doesNotMatch(out, /gatewayUrl/);
  assert.doesNotMatch(out, /gatewayToken/);
  assert.match(out, /name: n1/);

  const loaded = loadSharedConfig(cfgPath).config;
  assert.equal(loaded.node.gatewayUrl, '');
  assert.equal(loaded.node.gatewayToken, '');
});

test('persistChildGatewayTarget：段缺失则补齐；文件不存在则创建；非法 url 拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));

  const p1 = join(dir, 'a.yaml');
  writeFileSync(p1, 'gateway:\n  server:\n    port: 9000\n', 'utf8');
  persistChildGatewayTarget(p1, 'weixin', { url: 'http://x:1', token: '' });
  assert.match(readFileSync(p1, 'utf8'), /weixin:\n  gatewayUrl: http:\/\/x:1/);

  const p2 = join(dir, 'nested', 'config.yaml');
  assert.ok(!existsSync(p2));
  persistChildGatewayTarget(p2, 'node', { url: 'https://h:2', token: 't' });
  assert.match(readFileSync(p2, 'utf8'), /gatewayUrl: https:\/\/h:2/);

  assert.throws(() => persistChildGatewayTarget(p2, 'node', { url: 'ftp://bad', token: '' }), /http/);
});
