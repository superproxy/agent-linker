import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/install/layout.js';
import {
  InstallCliError,
  parseInstallCliArgs,
  resolveTargetInstallDir,
} from '../../../scripts/lib/install-cli-args.mjs';

test('parseInstallCliArgs：--help 与 --install-dir', () => {
  const h = parseInstallCliArgs(['--help'], { extras: ['--skip-build'] });
  assert.equal(h.help, true);
  assert.equal(h.installDir, undefined);

  const d = parseInstallCliArgs(['--install-dir', '/tmp/x', '--skip-build'], {
    extras: ['--skip-build'],
  });
  assert.equal(d.installDir, '/tmp/x');
  assert.equal(d.flags['--skip-build'], true);

  const eq = parseInstallCliArgs(['--install-dir=/opt/y'], { extras: [] });
  assert.equal(eq.installDir, '/opt/y');
});

test('parseInstallCliArgs：未知参数抛 InstallCliError', () => {
  assert.throws(
    () => parseInstallCliArgs(['--nope'], { extras: [] }),
    (err: unknown) => err instanceof InstallCliError && /未知参数/.test(err.message),
  );
});

test('resolveTargetInstallDir：CLI 优先于环境变量', () => {
  const dir = resolveTargetInstallDir({
    installDir: '/cli/path',
    env: { LINKAGENT_INSTALL: '/env/path' },
    readInstallMarker: false,
  });
  assert.match(dir.replace(/\\/g, '/'), /\/cli\/path$/);
});

test('local-install-update.mjs --help 不触发构建', () => {
  const repo = findRepoRoot();
  const script = join(repo, 'scripts', 'local-install-update.mjs');
  const r = spawnSync(process.execPath, [script, '--help'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--install-dir/);
  assert.doesNotMatch(r.stdout, /==>\s*pnpm build:dist/);
});
