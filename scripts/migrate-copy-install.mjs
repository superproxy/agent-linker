#!/usr/bin/env node
/**
 * 目录切换迁移：复制 config / .runtime-state 到另一安装目录，并写入 .linkagent-install。
 * 不删源；与 build:dist / install.sh 分离。
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateIntoTarget, writeExternalInstallMarkers } from './lib/migrate-run.mjs';
import {
  InstallCliError,
  parseInstallCliArgs,
  printMigrateCopyInstallHelp,
  resolveTargetInstallDir,
} from './lib/install-cli-args.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

let parsed;
try {
  parsed = parseInstallCliArgs(process.argv.slice(2), { extras: ['--dry-run'] });
} catch (err) {
  if (err instanceof InstallCliError) {
    console.error(`${err.message}\n`);
    printMigrateCopyInstallHelp();
    process.exit(1);
  }
  throw err;
}

if (parsed.help) {
  printMigrateCopyInstallHelp();
  process.exit(0);
}

const install = resolveTargetInstallDir({
  installDir: parsed.installDir,
  repoRoot: ROOT,
  readInstallMarker: false,
});
const legacy = process.env.LINKAGENT_LEGACY_ROOT?.trim();

if (parsed.flags['--dry-run']) {
  console.log(`[dry-run] 目标安装目录：${install}`);
  process.exit(0);
}

migrateIntoTarget(ROOT, install, legacy);
writeExternalInstallMarkers(ROOT, install);

console.log(`✅ 已复制到安装目录：${install}`);
console.log('   下一步：bash scripts/server-install-update.sh --restart');
console.log('   或本机：pnpm local:install-update');
