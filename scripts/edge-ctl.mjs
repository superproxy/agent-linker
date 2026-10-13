#!/usr/bin/env node
/** @deprecated 使用 edge-server-ctl.mjs */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(dir, "edge-server-ctl.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
