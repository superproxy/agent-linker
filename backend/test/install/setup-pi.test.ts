import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';
import {
  applyPiAgentConfig,
  applyPiSandboxConfig,
  mergePiSettings,
  parseSetupPiArgs,
  PI_ACP_PACKAGE,
} from '../../../scripts/setup-pi.mjs';

test('执行机安装钉死 pi-acp@0.0.33，不是未钉版本的 latest', () => {
  assert.equal(PI_ACP_PACKAGE, 'pi-acp@0.0.33');
});

test('parseSetupPiArgs：开关与路径', () => {
  const a = parseSetupPiArgs(['--skip-install', '--force', '--sandbox', '--home=/tmp/x', '--templates=/t']);
  assert.equal(a.skipInstall, true);
  assert.equal(a.force, true);
  assert.equal(a.sandbox, true);
  assert.equal(a.home, '/tmp/x');
  assert.equal(a.templates, '/t');
});

test('mergePiSettings：不覆盖已有默认模型，force 才改', () => {
  const patch = { defaultProvider: 'my', defaultModel: 'doubao-seed-2-0-pro-260215' };
  const keep = mergePiSettings({ theme: 'dark', defaultProvider: 'other', defaultModel: 'x' }, patch, false);
  assert.equal(keep.theme, 'dark');
  assert.equal(keep.defaultProvider, 'other');
  assert.equal(keep.defaultModel, 'x');
  const forced = mergePiSettings({ theme: 'dark', defaultProvider: 'other' }, patch, true);
  assert.equal(forced.theme, 'dark');
  assert.equal(forced.defaultProvider, 'my');
  assert.equal(forced.defaultModel, 'doubao-seed-2-0-pro-260215');
});

test('applyPiAgentConfig：首次写入，再次默认保留 models.json', () => {
  const repo = findRepoRoot();
  const templateDir = join(repo, 'backend', 'config', 'pi-agent');
  const agentDir = join(mkdtempSync(join(tmpdir(), 'pi-setup-')), 'agent');
  const first = applyPiAgentConfig({ agentDir, templateDir, force: false });
  assert.equal(first.models, 'wrote');
  const modelsPath = join(agentDir, 'models.json');
  const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
    providers: { my: { apiKey: string; models: { id: string }[] } };
  };
  assert.equal(models.providers.my.apiKey, '${ARK_API_KEY}');
  assert.ok(models.providers.my.models.some((m) => m.id === 'doubao-seed-2-0-pro-260215'));
  writeFileSync(modelsPath, '{"providers":{}}\n');
  const second = applyPiAgentConfig({ agentDir, templateDir, force: false });
  assert.equal(second.models, 'kept');
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, 'utf8')), { providers: {} });
  applyPiAgentConfig({ agentDir, templateDir, force: true });
  const again = JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers: { my?: unknown } };
  assert.ok(again.providers.my);
});

test('applyPiSandboxConfig：默认可 ls skills，并放行 curl 127.0.0.1', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sb-'));
  const agentDir = join(root, '.pi', 'agent');
  const first = applyPiSandboxConfig({ agentDir });
  assert.deepEqual(first.config.filesystem.additionalAllowRead, [
    join(agentDir, 'skills'),
    join(root, '.agents', 'skills'),
  ]);
  assert.deepEqual(first.config.network.allowedDomains, ['127.0.0.1']);
  assert.equal(first.config.subagents.provider, 'builtin');

  writeFileSync(
    first.configPath,
    JSON.stringify({
      subagents: { provider: 'off' },
      filesystem: { additionalAllowRead: ['/opt/extra'] },
      network: { allowedDomains: ['registry.npmjs.org:443'], deniedDomains: ['uploads.github.com'] },
      hostIPC: { mode: 'off', preflightCommandPrefixes: ['tmux'], retryOnUnixSocketError: false },
    }),
  );
  const second = applyPiSandboxConfig({ agentDir });
  assert.equal(second.config.subagents.provider, 'off');
  assert.deepEqual(second.config.filesystem.additionalAllowRead, [
    '/opt/extra',
    join(agentDir, 'skills'),
    join(root, '.agents', 'skills'),
  ]);
  assert.deepEqual(second.config.network.allowedDomains, ['registry.npmjs.org:443', '127.0.0.1']);
  assert.deepEqual(second.config.network.deniedDomains, ['uploads.github.com']);
  assert.deepEqual(second.config.hostIPC.preflightCommandPrefixes, ['tmux']);
  const third = applyPiSandboxConfig({ agentDir });
  assert.equal(third.config.network.allowedDomains.filter((d: string) => d === '127.0.0.1').length, 1);
  assert.equal(third.config.filesystem.additionalAllowRead.filter((p: string) => p.endsWith(`${join('agent', 'skills')}`)).length, 1);
});

test('setup-pi.mjs --skip-install --home 生成 agent 目录', () => {
  const repo = findRepoRoot();
  const home = mkdtempSync(join(tmpdir(), 'pi-home-'));
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'setup-pi.mjs'), '--skip-install', `--home=${home}`], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(existsSync(join(home, 'agent', 'models.json')), true);
  assert.equal(existsSync(join(home, 'agent', 'settings.json')), true);
  const settings = JSON.parse(readFileSync(join(home, 'agent', 'settings.json'), 'utf8')) as {
    defaultProvider: string;
    defaultModel: string;
  };
  assert.equal(settings.defaultProvider, 'my');
  assert.equal(settings.defaultModel, 'doubao-seed-2-0-pro-260215');
});
