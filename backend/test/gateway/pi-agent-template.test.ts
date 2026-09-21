import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';

test('pi-agent：不附带火山等厂商写死模型模板，由 ACP/pi 自己维护', () => {
  const dir = join(findRepoRoot(), 'backend', 'config', 'pi-agent');
  assert.equal(existsSync(join(dir, 'models.json.template')), false);
  assert.equal(existsSync(join(dir, 'settings.json.template')), false);
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /pi-acp/);
  assert.doesNotMatch(readme, /doubao-seed-2-0-pro-260215/);
  assert.doesNotMatch(readme, /ARK_API_KEY/);
});
