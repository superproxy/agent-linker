#!/usr/bin/env node
/** 兼容旧路径 → scripts/deploy-local-install-update.mjs */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deploy-local-install-update.mjs');
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
