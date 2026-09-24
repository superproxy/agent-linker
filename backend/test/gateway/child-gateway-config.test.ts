import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistChildGatewayTarget, loadSharedConfig } from '../../src/gateway/config.js';

function rt(dir: string): string {
  return join(dir, 'runtime-gateway');
}

function writeSplit(dir: string, files: { gateway?: string; weixin?: string; node?: string }): string {
  mkdirSync(dir, { recursive: true });
  const gw = join(dir, 'gateway.yaml');
  writeFileSync(gw, files.gateway ?? 'server:\n  host: 127.0.0.1\n  port: 8787\n');
  if (files.weixin) writeFileSync(join(dir, 'weixin.yaml'), files.weixin);
  if (files.node) writeFileSync(join(dir, 'node.yaml'), files.node);
  return gw;
}

test('persistChildGatewayTarget：写入 overlay，yaml 注释与其它键不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));
  const cfgPath = writeSplit(dir, {
    weixin: [
      '# 顶部注释应保留',
      'mode: external',
    ].join('\n'),
    node: 'name: n1',
  });
  const runtimeDir = rt(dir);

  persistChildGatewayTarget(cfgPath, 'weixin', { url: 'http://192.168.1.10:8787/', token: 'tok123' }, runtimeDir);
  const out = readFileSync(join(dir, 'weixin.yaml'), 'utf8');
  assert.match(out, /# 顶部注释应保留/);
  assert.doesNotMatch(out, /gatewayUrl/);
  assert.match(out, /mode: external/);

  const overlay = JSON.parse(readFileSync(join(runtimeDir, 'overlay.json'), 'utf8'));
  assert.equal(overlay.childGateway.weixin.gatewayUrl, 'http://192.168.1.10:8787');
  assert.equal(overlay.childGateway.weixin.gatewayToken, 'tok123');

  const loaded = loadSharedConfig(cfgPath, runtimeDir).config;
  assert.equal(loaded.weixin.gatewayUrl, 'http://192.168.1.10:8787');
  assert.equal(loaded.weixin.gatewayToken, 'tok123');
  assert.equal(loaded.node.gatewayUrl, '');
});

test('persistChildGatewayTarget：切回本机（空 url）overlay 清空；yaml 里旧键保留但不生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));
  const cfgPath = writeSplit(dir, {
    node: [
      'name: n1',
      'gatewayUrl: https://remote.example.com',
      'gatewayToken: secret',
    ].join('\n'),
  });
  const runtimeDir = rt(dir);

  persistChildGatewayTarget(cfgPath, 'node', { url: '', token: '' }, runtimeDir);
  const out = readFileSync(join(dir, 'node.yaml'), 'utf8');
  assert.match(out, /gatewayUrl: https:\/\/remote\.example\.com/);
  assert.match(out, /name: n1/);

  const loaded = loadSharedConfig(cfgPath, runtimeDir).config;
  assert.equal(loaded.node.gatewayUrl, '');
  assert.equal(loaded.node.gatewayToken, '');
});

test('persistChildGatewayTarget：段缺失可写 overlay；config 不存在时用默认 yaml 底；非法 url 拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-cgw-'));
  const runtimeDir = rt(dir);

  const p1 = writeSplit(dir, { gateway: 'server:\n  port: 9000\n' });
  persistChildGatewayTarget(p1, 'weixin', { url: 'http://x:1', token: '' }, runtimeDir);
  assert.equal(loadSharedConfig(p1, runtimeDir).config.weixin.gatewayUrl, 'http://x:1');

  const nested = join(dir, 'nested');
  mkdirSync(nested, { recursive: true });
  const p2 = join(nested, 'gateway.yaml');
  assert.ok(!existsSync(p2));
  persistChildGatewayTarget(p2, 'node', { url: 'https://h:2', token: 't' }, join(dir, 'rt2'));
  assert.ok(existsSync(join(dir, 'rt2', 'overlay.json')));

  assert.throws(() => persistChildGatewayTarget(p2, 'node', { url: 'ftp://bad', token: '' }, runtimeDir), /http/);
});
