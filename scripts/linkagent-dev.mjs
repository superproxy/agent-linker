#!/usr/bin/env node
/** 在仓库根以 LINKAGENT_DEV=1 跑 backend 脚本，配置/运行态仍用 <repo>/config 与 .runtime-state */
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const backendArgs = process.argv.slice(2);
const sub = backendArgs[0] === 'pm' ? ['--filter', '@linkagent/backend', 'pm', ...backendArgs.slice(1)] : ['--filter', '@linkagent/backend', 'dev'];

const env = { ...process.env, LINKAGENT_DEV: '1' };
const r = spawnSync('pnpm', sub, { cwd: ROOT, stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
