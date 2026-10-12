#!/usr/bin/env node
/**
 * 跨平台边缘启停：Unix → scripts/edge.sh，Windows → scripts/edge.ps1
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { psScriptPath, shellScriptPath } from "./lib/shell-entry.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] ?? "start";

const help = `用法
  pnpm edge [命令]
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

const isWin = process.platform === "win32";
const child = isWin
  ? spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScriptPath(dir, "edge"), ...args],
      { stdio: "inherit", windowsHide: false },
    )
  : spawn("bash", [shellScriptPath(dir, "edge"), ...args], { stdio: "inherit" });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
