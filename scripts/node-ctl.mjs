#!/usr/bin/env node
/** 兼容入口：实现见 dev-node-ctl.mjs */
export { resolveNodeLaunch, NODE_LAUNCH_HELP } from './dev-node-ctl.mjs';

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (self === entry) {
  const target = path.join(path.dirname(self), 'dev-node-ctl.mjs');
  const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
