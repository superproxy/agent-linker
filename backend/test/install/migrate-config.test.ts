import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeConfigFromTemplates,
  migrateConfigInto,
} from '../../../scripts/lib/migrate-install.mjs';
import { migrateIntoTarget } from '../../../scripts/lib/migrate-run.mjs';
import { resolveConfigPaths } from '../../src/config/paths.js';

test('materializeConfigFromTemplates：仅有 template 时生成 split 四文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagent-migrate-cfg-'));
  writeFileSync(join(dir, 'gateway.yaml.template'), 'server:\n  port: 8787\n');
  writeFileSync(join(dir, 'channels.yaml.template'), 'channelGateway:\n  enabled: false\n');
  writeFileSync(join(dir, 'weixin.yaml.template'), 'enabled: false\n');
  writeFileSync(join(dir, 'node.yaml.template'), 'enabled: false\n');

  materializeConfigFromTemplates(dir);

  assert.ok(existsSync(join(dir, 'gateway.yaml')));
  assert.ok(existsSync(join(dir, 'channels.yaml')));
  assert.equal(resolveConfigPaths(join(dir, 'gateway.yaml')).mode, 'split');
  assert.match(readFileSync(join(dir, 'channels.yaml'), 'utf8'), /channelGateway/);
});

test('migrateConfigInto：冲突时默认跳过，--overwrite-config 覆盖', () => {
  const dest = mkdtempSync(join(tmpdir(), 'linkagent-migrate-dest-'));
  const src = mkdtempSync(join(tmpdir(), 'linkagent-migrate-src-'));
  writeFileSync(join(dest, 'weixin.yaml'), 'enabled: false\n');
  writeFileSync(join(src, 'weixin.yaml'), 'enabled: true\n');

  const skipped = migrateConfigInto(dest, [src], { overwriteConfig: false });
  assert.equal(skipped.length, 1);
  assert.match(readFileSync(join(dest, 'weixin.yaml'), 'utf8'), /enabled: false/);

  migrateConfigInto(dest, [src], { overwriteConfig: true });
  assert.match(readFileSync(join(dest, 'weixin.yaml'), 'utf8'), /enabled: true/);
});

test('migrateIntoTarget：默认仅 config，不写入 .runtime-state', () => {
  const repo = mkdtempSync(join(tmpdir(), 'linkagent-migrate-repo-'));
  const target = mkdtempSync(join(tmpdir(), 'linkagent-migrate-tgt-'));
  const secret = join(repo, '.runtime-state', 'users', 'admin.json');
  mkdirSync(join(repo, '.runtime-state', 'users'), { recursive: true });
  writeFileSync(secret, '{"x":1}\n');

  migrateIntoTarget(repo, target, undefined, {});

  assert.equal(existsSync(join(target, '.runtime-state', 'users', 'admin.json')), false);

  migrateIntoTarget(repo, target, undefined, { includeRuntime: true });
  assert.equal(existsSync(join(target, '.runtime-state', 'users', 'admin.json')), true);
});
