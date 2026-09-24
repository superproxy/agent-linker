import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallLayout } from '../../src/install/layout.js';
import { loadGatewayRuntimeConfig } from '../../src/supervisor/manager.js';

test('loadGatewayRuntimeConfig：split 三文件时读 gateway 端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkagent-pm-cfg-'));
  const cfgDir = join(root, 'backend', 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'gateway.yaml'), 'server:\n  host: 127.0.0.1\n  port: 9009\nauth:\n  mode: open\nagents: []\n');
  writeFileSync(join(cfgDir, 'weixin.yaml'), 'enabled: false\n');
  writeFileSync(join(cfgDir, 'node.yaml'), 'enabled: false\nagents: []\n');
  const layout = createInstallLayout(root);
  assert.equal(layout.configMode, 'split');
  const gw = loadGatewayRuntimeConfig(layout);
  assert.equal(gw.port, 9009);
  assert.equal(gw.shared.gateway.server.port, 9009);
});
