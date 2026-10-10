#!/usr/bin/env node
/**
 * 目录切换迁移：复制 config / .runtime-state 到另一安装目录，并写入 .linkagent-install。
 * 不删源；与 build:dist / install.sh 分离。
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInstallRoot } from './lib/install-paths.mjs';
import { migrateIntoTarget, writeExternalInstallMarkers } from './lib/migrate-run.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log(`用法: node scripts/migrate-copy-install.mjs [--dry-run]

  复制到 LINKAGENT_INSTALL（缺省 Linux /opt/agent-linker，Windows %%ProgramData%%\\linkagent）。
  写入 .linkagent-install + .linkagent-server，后续 pm/edge/server-install-update 走该目录。

  环境变量：
    LINKAGENT_INSTALL   目标绝对路径
    LINKAGENT_LEGACY_ROOT  额外来源（如曾在 dist/linkagent 内运行）

  **服务器首次从旧布局迁出**：必须先执行 migrate-repo-layout，再本脚本（或 migrate-server-from-legacy.sh）。
`);
  process.exit(0);
}

function resolveInstallTarget() {
  const env = process.env.LINKAGENT_INSTALL?.trim();
  if (env) return resolve(env);
  return resolve(defaultInstallRoot());
}

const install = resolveInstallTarget();
const legacy = process.env.LINKAGENT_LEGACY_ROOT?.trim();

if (process.argv.includes('--dry-run')) {
  console.log(`[dry-run] 目标安装目录：${install}`);
  process.exit(0);
}

migrateIntoTarget(ROOT, install, legacy);
writeExternalInstallMarkers(ROOT, install);

console.log(`✅ 已复制到安装目录：${install}`);
console.log('   下一步：bash scripts/server-install-update.sh --restart');
console.log('   或本机：pnpm local:install-update');
