#!/usr/bin/env node
/** @deprecated 使用 edge-config-ctl.mjs */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(dir, "edge-config-ctl.mjs")], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
