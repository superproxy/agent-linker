#!/usr/bin/env node
/** 兼容 → local-stack-ctl.mjs */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-stack-ctl.mjs");
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
