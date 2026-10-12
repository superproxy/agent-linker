import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRuntimeOverlay,
  createGatewayRuntimeRepository,
  resolveGatewayRuntimeBackend,
  RUNTIME_OVERLAY_FILENAME,
} from '../../src/gateway/store/runtime/index.js';
import { persistGatewayServerPort } from '../../src/config/persist.js';
import { loadSharedConfig } from '../../src/config/load.js';
import { writeFileSync, mkdirSync } from 'node:fs';

test('resolveGatewayRuntimeBackend：默认 json-overlay', () => {
  const prev = process.env.LINKAGENT_RUNTIME_STORE;
  delete process.env.LINKAGENT_RUNTIME_STORE;
  try {
    assert.equal(resolveGatewayRuntimeBackend(), 'json-overlay');
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_RUNTIME_STORE;
    else process.env.LINKAGENT_RUNTIME_STORE = prev;
  }
});

test('createGatewayRuntimeRepository：json 写入 overlay 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-rt-'));
  const repo = createGatewayRuntimeRepository(dir);
  repo.setDefaultTaskAgentId('codex');
  const file = join(dir, RUNTIME_OVERLAY_FILENAME);
  assert.ok(existsSync(file));
  const overlay = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: { defaultAgentId?: string } };
  assert.equal(overlay.tasks?.defaultAgentId, 'codex');
});

test('setGatewayServerPort：overlay 覆盖有效配置端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkagent-rt-port-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  const gwYaml = join(root, 'config', 'gateway.yaml');
  writeFileSync(gwYaml, 'server:\n  host: 127.0.0.1\n  port: 8787\n', 'utf8');
  const rtDir = join(root, '.runtime-state', 'gateway');
  const repo = createGatewayRuntimeRepository(rtDir);
  repo.setGatewayServerPort(9123);
  const base = loadSharedConfig(gwYaml, rtDir).config;
  const merged = applyRuntimeOverlay(base, repo.loadOverlay());
  assert.equal(merged.gateway.server.port, 9123);
});

test('persistGatewayServerPort：loadSharedConfig 读到新端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkagent-cfg-port-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  const gwYaml = join(root, 'config', 'gateway.yaml');
  writeFileSync(gwYaml, 'server:\n  host: 127.0.0.1\n  port: 8787\n', 'utf8');
  const rtDir = join(root, '.runtime-state', 'gateway');
  persistGatewayServerPort(gwYaml, 9456, rtDir);
  const loaded = loadSharedConfig(gwYaml, rtDir);
  assert.equal(loaded.config.gateway.server.port, 9456);
});

test('resolveGatewayRuntimeBackend：sqlite 可选但仓储尚未实现', () => {
  const prev = process.env.LINKAGENT_RUNTIME_STORE;
  process.env.LINKAGENT_RUNTIME_STORE = 'sqlite';
  try {
    assert.equal(resolveGatewayRuntimeBackend(), 'sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'linkagent-rt-sql-'));
    const repo = createGatewayRuntimeRepository(dir);
    assert.throws(() => repo.setDefaultTaskAgentId('pi'), /尚未实现/);
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_RUNTIME_STORE;
    else process.env.LINKAGENT_RUNTIME_STORE = prev;
  }
});
