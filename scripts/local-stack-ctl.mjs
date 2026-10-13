#!/usr/bin/env node
/**
 * 本机完整栈（edge + gateway + channels + node），PM 进程模式，非 tsx 源码 dev。
 * 见 scripts/local-stack.sh、local-stack-enhance.sh 与 docs/local-stack-enhance.md
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

const HELP = `用法（本机 PM 栈，非 pnpm dev 源码模式）

  node scripts/local-stack-ctl.mjs start              原生：edge + gateway + PM node
  node scripts/local-stack-ctl.mjs start:enhance      单机 enhance（+ code-server + 宿主机 frpc）
  node scripts/local-stack-ctl.mjs start:enhance:docker  整栈 + Docker 聚合节点
  stop | restart | status | restart:enhance | …

快捷脚本：
  scripts/local-stack.sh          原生栈
  scripts/local-stack-enhance.sh  enhance 单机模式

pnpm：local:start / local:enhance / local:stack:*
详见 docs/local-stack-enhance.md
`;

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
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
