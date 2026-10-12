#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.error('提示：migrate-copy-install 已更名为 migrate-install-config（默认仅配置）\n');
const script = join(dirname(fileURLToPath(import.meta.url)), 'migrate-install-config.mjs');
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
