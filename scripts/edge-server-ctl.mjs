#!/usr/bin/env node
/**
 * 边缘进程启停（frps 宿主机 + APISIX Docker）：Unix → edge-server-ctl.sh，Windows → edge-server-ctl.ps1
 * 仅写配置、不启进程：scripts/edge-config-ctl.mjs（dist 内 bin/edge.mjs）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRootShellScriptPath, psScriptPath } from "./lib/shell-entry.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);
const installRoot = process.env.LINKAGENT_HOME?.trim() || repo;
const args = process.argv.slice(2);
const cmd = args[0] ?? "start";

const help = `用法
  pnpm edge [命令]              （等同 edge-server-ctl）
  pnpm edge:config              只写 frps/APISIX 配置（不启进程）

  pnpm edge:start | edge:stop | edge:restart | edge:status | edge:log | edge:build

命令（缺省 start）
  start     启动 frps + APISIX（Docker Compose）
  stop      停止
  restart   重启
  status    状态
  log       跟随 frps / APISIX 日志
  build     构建 linkagent-apisix:local 镜像

在安装根目录执行；可选 LINKAGENT_HOME。需已安装 Docker Desktop。
`;

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(help);
  process.exit(0);
}

const spawnEnv = { ...process.env, LINKAGENT_HOME: installRoot };
const isWin = process.platform === "win32";
const child = isWin
  ? spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScriptPath(dir, "edge-server-ctl"), ...args],
      { stdio: "inherit", windowsHide: false, cwd: installRoot, env: spawnEnv },
    )
  : spawn("bash", [installRootShellScriptPath(dir, "edge-server-ctl"), ...args], {
      stdio: "inherit",
      cwd: installRoot,
      env: spawnEnv,
    });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
