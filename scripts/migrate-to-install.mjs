#!/usr/bin/env node
console.error('已更名：');
console.error('  仓库内配置 → scripts/migrate-config.mjs       （pnpm migrate:config）');
console.error('  迁到安装目录 → scripts/migrate-install-config.mjs （pnpm migrate:install-config）');
console.error('  旧 pnpm migrate:repo / migrate:copy 仍可用（转发到新脚本）');
process.exit(1);
