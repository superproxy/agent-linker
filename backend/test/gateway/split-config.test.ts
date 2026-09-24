import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSharedConfig } from '../../src/gateway/config.js';

test('loadSharedConfig：split 三文件合并为有效配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-split-'));
  writeFileSync(
    join(dir, 'gateway.yaml'),
    'server:\n  host: 10.0.0.1\n  port: 9001\nauth:\n  mode: token\n  token: tok\nagents: []\ntasks:\n  defaultAgentId: opencode\n',
  );
  writeFileSync(join(dir, 'weixin.yaml'), 'enabled: true\nmode: external\nmodel: agent:pi\n');
  writeFileSync(join(dir, 'node.yaml'), 'enabled: true\nagents:\n  - codex\n');

  const rt = join(dir, 'rt');
  const loaded = loadSharedConfig(join(dir, 'gateway.yaml'), rt);
  assert.equal(loaded.mode, 'split');
  assert.equal(loaded.config.gateway.server.port, 9001);
  assert.equal(loaded.config.gateway.auth.mode, 'token');
  assert.equal(loaded.config.weixin.mode, 'external');
  assert.deepEqual(
    loaded.config.node.agents.map((a) => (typeof a === 'string' ? a : a.id)),
    ['codex'],
  );
});
