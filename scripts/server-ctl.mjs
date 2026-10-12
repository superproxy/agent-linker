#!/usr/bin/env node
/**
 * 跨平台 gateway 启停：Unix → scripts/server.sh，Windows → scripts/server.ps1
 * 安装根默认当前工作目录（见 layout.findInstallRoot / server 脚本内逻辑）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] ?? "start";

const help = `用法
  pnpm server [命令]
  pnpm server:start | server:stop | server:restart | server:status | server:log | server:dev

命令（缺省 start）
  start       后台启动 gateway
  stop        停止
  restart     重启
  status      状态
  log         跟随日志
  foreground  前台运行（开发）

在目标安装目录下执行即可；可选 LINKAGENT_HOME 指向非 cwd 的安装根。
`;

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(help);
  process.exit(0);
}

const isWin = process.platform === "win32";
const child = isWin
  ? spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "server.ps1"), ...args],
      { stdio: "inherit", windowsHide: false },
    )
  : spawn("bash", [path.join(dir, "server.sh"), ...args], { stdio: "inherit" });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
