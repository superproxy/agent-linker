#!/usr/bin/env node
/**
 * 本机方案一键启停：edge → gateway → node（见 dev-local-stack.ps1 / dev-local-stack.sh）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);
const argv = process.argv.slice(2).filter((a) => a !== "--");
let rawCmd = argv[0] ?? "start";
let enhance = argv.includes("enhance") || argv.includes("--enhance") || rawCmd === "enhance";
let enhanceDocker = argv.includes("docker") || rawCmd.includes(":docker");
let cmd = rawCmd;
const parts = rawCmd.split(":").filter(Boolean);
if (parts.length > 1) {
  cmd = parts[0] ?? "start";
  const rest = parts.slice(1);
  if (rest.includes("enhance") && rest.includes("docker")) {
    enhanceDocker = true;
    enhance = false;
  } else if (rest.includes("enhance")) {
    enhance = true;
  } else if (rest.length > 0) {
    console.error(`未知子命令: ${rawCmd}（支持 start:enhance、start:enhance:docker、restart:enhance 等）`);
    process.exit(1);
  }
}
if (rawCmd === "enhance") {
  cmd = "start";
  enhance = true;
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`用法
  pnpm local:stack:start                    原生栈（PM node，无浏览器 IDE 容器）
  pnpm local:stack:start:enhance            edge 增强 + 单机模式（PM + code-server + 宿主机 frpc）
  pnpm local:stack:start:enhance:docker     edge 增强 + Docker 模式（linkagent-node 聚合容器）
  pnpm local:stack:stop | restart | status

Local：浏览器 IDE 二选一——单机模式 或 Docker 模式，不要同时开。详见 docs/local-stack-enhance.md
`);
  process.exit(0);
}

const isWin = process.platform === "win32";
const psArgs = enhanceDocker ? [cmd, "-EnhanceDocker"] : enhance ? [cmd, "-Enhance"] : [cmd];
const shArgs = enhanceDocker ? [`${cmd}:enhance:docker`] : enhance ? [`${cmd}:enhance`] : [cmd];
const child = isWin
  ? spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "dev-local-stack.ps1"), ...psArgs],
      { stdio: "inherit", cwd: repo, windowsHide: false },
    )
  : spawn("bash", [path.join(dir, "dev-local-stack.sh"), ...shArgs], { stdio: "inherit", cwd: repo });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
