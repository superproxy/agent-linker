#!/usr/bin/env node
/**
 * 配置迁移到安装目录：复制 config 到外部安装根，并写入 .linkagent-install。
 * 默认不复制 .runtime-state；不删源。
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateIntoTarget, writeExternalInstallMarkers } from './lib/migrate-run.mjs';
import {
  InstallCliError,
  parseInstallCliArgs,
  printMigrateInstallConfigHelp,
  resolveTargetInstallDir,
} from './lib/install-cli-args.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

let parsed;
try {
  parsed = parseInstallCliArgs(process.argv.slice(2), {
    extras: [
      '--dry-run',
      '--overwrite',
      '--overwrite-config',
      '--overwrite-runtime',
      '--with-runtime',
    ],
  });
} catch (err) {
  if (err instanceof InstallCliError) {
    console.error(`${err.message}\n`);
    printMigrateInstallConfigHelp();
    process.exit(1);
  }
  throw err;
}

if (parsed.help) {
  printMigrateInstallConfigHelp();
  process.exit(0);
}

const install = resolveTargetInstallDir({
  installDir: parsed.installDir,
  repoRoot: ROOT,
  readInstallMarker: false,
});
const legacy = process.env.LINKAGENT_LEGACY_ROOT?.trim();
const includeRuntime = Boolean(parsed.flags['--with-runtime']);

if (parsed.flags['--dry-run']) {
  console.log(
    `[dry-run] 目标安装目录：${install}${includeRuntime ? '（含 .runtime-state）' : '（仅 config）'}`,
  );
  process.exit(0);
}

const overwriteAll = Boolean(parsed.flags['--overwrite']);
const migrateOpts = {
  includeRuntime,
  overwriteConfig: overwriteAll || Boolean(parsed.flags['--overwrite-config']),
  overwriteRuntime: overwriteAll || Boolean(parsed.flags['--overwrite-runtime']),
};

const { configConflicts, runtimeConflicts } = migrateIntoTarget(ROOT, install, legacy, migrateOpts);
writeExternalInstallMarkers(ROOT, install);

const conflictCount = configConflicts.length + runtimeConflicts.length;
if (conflictCount > 0) {
  console.error('');
  console.error(`❌ 迁移完成但有 ${conflictCount} 处冲突未写入（目标已存在）。`);
  for (const c of configConflicts) {
    console.error(`   配置 ${c.name}: ${c.src}`);
  }
  if (runtimeConflicts.length > 0) {
    console.error(`   运行态: ${runtimeConflicts.length} 个路径（示例 ${runtimeConflicts[0]?.rel ?? ''}）`);
  }
  console.error('   确认后重跑：node scripts/migrate-install-config.mjs --overwrite-config');
  if (includeRuntime) {
    console.error('   或：--overwrite-runtime / --overwrite（两者都覆盖）');
  }
  process.exit(1);
}

console.log(`✅ 已复制配置到安装目录：${install}/config/`);
if (includeRuntime) console.log(`   运行态：${install}/.runtime-state/`);
console.log('   仓库根已写入 .linkagent-install → 上述路径');
console.log('   下一步：pnpm local:install-update（本机）或 bash scripts/server-install-update.sh --restart（Linux 源码机）');
console.log('   启动：cd 安装目录 && start.bat start（Windows）或 ./start.sh start');
