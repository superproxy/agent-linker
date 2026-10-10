#!/usr/bin/env node
/**
 * 开发/运行迁移：在仓库根整理 config + .runtime-state（运行目录=开发目录）。
 * 不复制到外部路径；移除 .linkagent-install / .linkagent-server。
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearExternalInstallMarkers, migrateIntoTarget } from './lib/migrate-run.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`用法: node scripts/migrate-repo-layout.mjs [--dry-run]

  将 backend/config、dist/linkagent、LINKAGENT_LEGACY_ROOT 等来源中
  **尚未存在于** <repo>/config 与 <repo>/.runtime-state 的内容合并进仓库（不覆盖、不删除源）。

  适用：本机与服务器在 clone 目录直接 dev/pm 运行。
  环境变量：LINKAGENT_LEGACY_ROOT=旧整包运行目录（如 dist/linkagent）。
`);
  process.exit(0);
}

if (process.argv.includes('--dry-run')) {
  console.log(`[dry-run] 目标：${ROOT}`);
  process.exit(0);
}

const legacy = process.env.LINKAGENT_LEGACY_ROOT?.trim();
migrateIntoTarget(ROOT, ROOT, legacy);
clearExternalInstallMarkers(ROOT);

console.log(`✅ 已整理仓库运行布局：${ROOT}`);
console.log('   配置：config/*.yaml；运行态：.runtime-state/');
console.log('   启动：pnpm dev 或 pnpm --filter @linkagent/backend pm');
