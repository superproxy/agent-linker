#!/usr/bin/env node
/**
 * 安装根 gateway 启停：Unix → 安装根 server-ctl.sh，Windows → scripts/server-ctl.ps1（若有）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRootShellScriptPath, psScriptPath } from './lib/shell-entry.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] ?? 'start';

const help = `用法
  node scripts/server-ctl.mjs [命令] [gateway|weixin|node|all]

命令（缺省 start）
  start | stop | restart | status | logs | foreground

在运行安装根目录执行（cd /opt/agent-linker）。
`;

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(help);
  process.exit(0);
}

const isWin = process.platform === 'win32';
const sh = installRootShellScriptPath(dir, 'server-ctl');
const ps = psScriptPath(dir, 'server-ctl');
const child = isWin
  ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, ...args], {
      stdio: 'inherit',
      windowsHide: false,
    })
  : spawn('bash', [sh, ...args], { stdio: 'inherit' });

child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
