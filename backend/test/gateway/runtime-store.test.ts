import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGatewayRuntimeRepository,
  resolveGatewayRuntimeBackend,
  RUNTIME_OVERLAY_FILENAME,
} from '../../src/gateway/store/runtime/index.js';

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
