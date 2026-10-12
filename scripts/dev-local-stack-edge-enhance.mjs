#!/usr/bin/env node
/**
 * local:stack enhance 的 edge 增强：构建 APISIX 镜像 → 重启 edge → 重启 gateway 以同步 APISIX 任务路由（-web|-code|-vnc）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);

function run(label, script, args = []) {
  console.log(`→ ${label}`);
  const r = spawnSync(process.execPath, [path.join(dir, script), ...args], {
    cwd: repo,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

run("edge enhance：构建 APISIX 镜像", "edge-ctl.mjs", ["build"]);
run("edge enhance：重启 frps + APISIX", "edge-ctl.mjs", ["restart"]);
run("edge enhance：重启 gateway（同步 APISIX 任务路由）", "dev-server-ctl.mjs", ["restart"]);
