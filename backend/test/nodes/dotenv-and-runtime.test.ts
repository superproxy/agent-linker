import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConfig } from '@linkagent/shared/config';
import { applyDotenvFile, parseDotenvLine } from '../../src/config/dotenv-file.js';
import { resolveChildRuntime } from '../../src/config/child-runtime.js';
import { loadNodeConnectorEnvFiles } from '../../src/node/env-load.js';

test('parseDotenvLine：引号与注释', () => {
  assert.deepEqual(parseDotenvLine("LINKAGENT_GATEWAY_URL='ws://a:8787'"), [
    'LINKAGENT_GATEWAY_URL',
    'ws://a:8787',
  ]);
  assert.equal(parseDotenvLine('# comment'), null);
});

test('applyDotenvFile：不覆盖已有环境变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'la-dotenv-'));
  const file = join(dir, 'node.env');
  writeFileSync(file, 'LINKAGENT_GATEWAY_URL=ws://from-file:8787\n', 'utf8');
  const prev = process.env.LINKAGENT_GATEWAY_URL;
  process.env.LINKAGENT_GATEWAY_URL = 'ws://from-shell:8787';
  try {
    applyDotenvFile(file);
    assert.equal(process.env.LINKAGENT_GATEWAY_URL, 'ws://from-shell:8787');
    delete process.env.LINKAGENT_GATEWAY_URL;
    applyDotenvFile(file);
    assert.equal(process.env.LINKAGENT_GATEWAY_URL, 'ws://from-file:8787');
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_GATEWAY_URL;
    else process.env.LINKAGENT_GATEWAY_URL = prev;
  }
});

test('loadNodeConnectorEnvFiles：安装根 node.env 注入 LINKAGENT_GATEWAY_URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'la-node-root-'));
  writeFileSync(join(root, '.linkagent-root'), '', 'utf8');
  mkdirSync(join(root, 'server', 'config'), { recursive: true });
  writeFileSync(
    join(root, 'server', 'config', 'gateway.yaml'),
    'server:\n  host: 127.0.0.1\n  port: 8787\nauth:\n  mode: local\n  token: ""\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'node.env'),
    'LINKAGENT_GATEWAY_URL=ws://216.19.4.113:8787\nLINKAGENT_NODE_CLAIM=nu_test\n',
    'utf8',
  );

  const prevHome = process.env.LINKAGENT_HOME;
  const prevUrl = process.env.LINKAGENT_GATEWAY_URL;
  const prevClaim = process.env.LINKAGENT_NODE_CLAIM;
  delete process.env.LINKAGENT_GATEWAY_URL;
  delete process.env.LINKAGENT_NODE_CLAIM;
  process.env.LINKAGENT_HOME = root;
  try {
    loadNodeConnectorEnvFiles();
    assert.equal(process.env.LINKAGENT_GATEWAY_URL, 'ws://216.19.4.113:8787');
    assert.equal(process.env.LINKAGENT_NODE_CLAIM, 'nu_test');

    const cfg = migrateConfig({ server: { host: '127.0.0.1', port: 8787 } });
    const runtime = resolveChildRuntime(
      cfg,
      {},
      { url: process.env.LINKAGENT_GATEWAY_URL, token: process.env.LINKAGENT_GATEWAY_TOKEN },
    );
    assert.equal(runtime.gatewayUrl, 'ws://216.19.4.113:8787');
  } finally {
    if (prevHome === undefined) delete process.env.LINKAGENT_HOME;
    else process.env.LINKAGENT_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.LINKAGENT_GATEWAY_URL;
    else process.env.LINKAGENT_GATEWAY_URL = prevUrl;
    if (prevClaim === undefined) delete process.env.LINKAGENT_NODE_CLAIM;
    else process.env.LINKAGENT_NODE_CLAIM = prevClaim;
  }
});
