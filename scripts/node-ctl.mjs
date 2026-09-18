#!/usr/bin/env node
/**
 * 跨平台调度：Unix 走 scripts/node.sh，Windows 走 scripts/node.ps1。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const isWin = process.platform === "win32";

const child = isWin
  ? spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(dir, "node.ps1"),
        ...args,
      ],
      { stdio: "inherit", windowsHide: false },
    )
  : spawn("bash", [path.join(dir, "node.sh"), ...args], { stdio: "inherit" });

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
