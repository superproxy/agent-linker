import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';

test('pi-agent 模板：火山方舟 my provider，密钥走环境变量', () => {
  const dir = join(findRepoRoot(), 'backend', 'config', 'pi-agent');
  assert.equal(existsSync(join(dir, 'models.json.template')), true);
  assert.equal(existsSync(join(dir, 'settings.json.template')), true);
  const models = JSON.parse(readFileSync(join(dir, 'models.json.template'), 'utf8')) as {
    providers?: { my?: { apiKey?: string } };
  };
  assert.equal(models.providers?.my?.apiKey, '${ARK_API_KEY}');
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json.template'), 'utf8')) as {
    defaultProvider?: string;
    defaultModel?: string;
  };
  assert.equal(settings.defaultProvider, 'my');
  assert.equal(settings.defaultModel, 'doubao-seed-2-0-pro-260215');
});
