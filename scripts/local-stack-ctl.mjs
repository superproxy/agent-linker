#!/usr/bin/env node
/**
 * 本机方案一键启停：edge → gateway → node（见 local-stack.ps1 / local-stack.sh）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(dir);
const cmd = process.argv[2] ?? process.argv[1] ?? "start";

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`用法
  pnpm local:stack [start|stop|restart|status]

本机 \`config/gateway.yaml\` → edge.publicHost: ide.localhost；
node 需 serveWeb.enabled 与 Docker（code-server + frpc → frps）。
`);
  process.exit(0);
}

const isWin = process.platform === "win32";
const child = isWin
  ? spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "local-stack.ps1"), cmd],
      { stdio: "inherit", cwd: repo, windowsHide: false },
    )
  : spawn("bash", [path.join(dir, "local-stack.sh"), cmd], { stdio: "inherit", cwd: repo });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
