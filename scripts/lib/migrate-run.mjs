import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrateConfigInto, mergeRuntimeInto } from './migrate-install.mjs';

export function collectMigrationSources(repoRoot, legacyRoot) {
  const legacy = legacyRoot?.trim();
  const configSources = [
    join(repoRoot, 'backend', 'config'),
    join(repoRoot, 'config'),
    join(repoRoot, 'server', 'config'),
    join(repoRoot, 'dist', 'linkagent', 'config'),
    legacy ? join(legacy, 'config') : '',
  ].filter((d) => d && existsSync(d));

  const runtimeSources = [
    join(repoRoot, 'dist', 'linkagent', '.runtime-state'),
    join(repoRoot, '.runtime-state'),
    legacy ? join(legacy, '.runtime-state') : '',
  ].filter((d) => d && existsSync(d));

  return { configSources, runtimeSources };
}

/** 缺项复制 config / .runtime-state 到 target；不删源。 */
export function migrateIntoTarget(repoRoot, target, legacyRoot) {
  const targetResolved = resolve(target);
  const installCfg = join(targetResolved, 'config');
  const installState = join(targetResolved, '.runtime-state');
  mkdirSync(installCfg, { recursive: true });
  mkdirSync(installState, { recursive: true });

  const { configSources, runtimeSources } = collectMigrationSources(repoRoot, legacyRoot);

  if (configSources.length) migrateConfigInto(installCfg, configSources);
  else console.log('→ 未找到可迁入的配置目录');

  if (runtimeSources.length) mergeRuntimeInto(installState, runtimeSources);
  else console.log('→ 未找到可合并的 .runtime-state');

  return targetResolved;
}

export function clearExternalInstallMarkers(repoRoot) {
  for (const name of ['.linkagent-install', '.linkagent-server']) {
    const f = join(repoRoot, name);
    if (existsSync(f)) unlinkSync(f);
  }
}

export function writeExternalInstallMarkers(repoRoot, installDir) {
  writeFileSync(join(repoRoot, '.linkagent-install'), `${resolve(installDir)}\n`, 'utf8');
  writeFileSync(join(repoRoot, '.linkagent-server'), 'server\n', 'utf8');
}
