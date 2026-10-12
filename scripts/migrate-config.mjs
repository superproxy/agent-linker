#!/usr/bin/env node
/**
 * 配置迁移：在仓库根合并 split 配置（gateway/weixin/channels/node、pi-agent）。
 * 默认不碰 .runtime-state；需要登录态等时用 --with-runtime。
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearExternalInstallMarkers, migrateIntoTarget } from './lib/migrate-run.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const argv = process.argv.slice(2);
const includeRuntime = argv.includes('--with-runtime');
const overwriteAll = argv.includes('--overwrite');
const migrateOpts = {
  includeRuntime,
  overwriteConfig: overwriteAll || argv.includes('--overwrite-config'),
  overwriteRuntime: overwriteAll || argv.includes('--overwrite-runtime'),
};

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`用法: node scripts/migrate-config.mjs [选项]

  在 **clone 根** 把各来源中尚未存在于 <repo>/config 的内容合并进仓库（默认不覆盖）。
  适用：本机与服务器在 clone 目录直接 dev/pm 运行。

选项:
  --overwrite-config     覆盖已有 yaml / pi-agent
  --with-runtime         同时合并 .runtime-state（缺省仅配置）
  --overwrite-runtime    与 --with-runtime 联用，覆盖已有运行态路径
  --overwrite            同时覆盖配置与运行态（需 --with-runtime 才有运行态）
  --dry-run              仅打印目标路径
  -h, --help             显示本帮助

环境变量:
  LINKAGENT_LEGACY_ROOT  额外来源（如曾在 dist/linkagent 内运行）
`);
  process.exit(0);
}

if (argv.includes('--dry-run')) {
  console.log(`[dry-run] 目标：${ROOT}${includeRuntime ? '（含 .runtime-state）' : '（仅 config）'}`);
  process.exit(0);
}

const legacy = process.env.LINKAGENT_LEGACY_ROOT?.trim();
const { configConflicts, runtimeConflicts } = migrateIntoTarget(ROOT, ROOT, legacy, migrateOpts);
clearExternalInstallMarkers(ROOT);

const conflictCount = configConflicts.length + runtimeConflicts.length;
if (conflictCount > 0) {
  console.error('');
  console.error(`❌ 配置迁移完成但有 ${conflictCount} 处冲突未写入。`);
  for (const c of configConflicts) {
    console.error(`   配置 ${c.name}: ${c.src}`);
  }
  if (runtimeConflicts.length > 0) {
    console.error(`   运行态: ${runtimeConflicts.length} 个路径`);
  }
  console.error('   确认后重跑：node scripts/migrate-config.mjs --overwrite-config');
  process.exit(1);
}

console.log(`✅ 已整理仓库配置：${ROOT}/config/`);
if (includeRuntime) console.log('   运行态：.runtime-state/');
console.log('   启动：pnpm dev 或 pnpm --filter @linkagent/backend pm');
