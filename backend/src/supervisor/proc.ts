/**
 * 跨平台进程原语（零第三方依赖，仅用 node 内置模块）：
 *   - 后台拉起子进程（detached + unref），stdout/stderr 追加到独立日志文件；
 *   - pid 文件存活判断；
 *   - 递归杀整棵进程树（POSIX 递归 pgrep；Windows taskkill /T /F）。
 *
 * 仅「编排拉起」：管理器 spawn 完即退出，不常驻、不监控、崩溃不自动重启。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';

export type Child = ChildProcess;

export const IS_WINDOWS = platform() === 'win32';

export interface SpawnOptions {
  /** 可执行文件 / 命令（如 tsx 绝对路径、node） */
  command: string;
  /** 参数 */
  args: string[];
  /** 工作目录 */
  cwd: string;
  /** 追加环境变量（继承 process.env 后覆盖） */
  env?: Record<string, string>;
  /** stdout/stderr 追加写入的日志文件（null 则继承父进程，前台模式用） */
  logFile?: string | null;
}

/** 读取 pid 文件；文件缺失 / pid 不存活 / 内容非法 → null */
export function readPid(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(pidFile: string, pid: number): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(pid), 'utf8');
}

export function removePid(pidFile: string): void {
  rmSync(pidFile, { force: true });
}

/** 进程是否存活（signal 0 探测） */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 不存在；EPERM = 存在但无权限（仍视为存活）
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 后台拉起：独立进程组（POSIX setsid / Windows 无意义），stdio 落日志文件，unref 后不阻塞父进程退出。
 */
export function spawnDetached(opts: SpawnOptions): Child {
  const stdio: Array<'ignore' | 'inherit' | number> = ['ignore', 'inherit', 'inherit'];
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    const fd = openSync(opts.logFile, 'a');
    stdio[1] = fd;
    stdio[2] = fd;
  }
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: stdio as ['ignore', 'inherit' | number, 'inherit' | number],
    detached: !IS_WINDOWS,
    windowsHide: IS_WINDOWS,
  });
  child.unref();
  return child;
}

/**
 * 前台拉起：继承当前终端 stdio，不 unref（用于 foreground 联调）。
 */
export function spawnAttached(opts: SpawnOptions): Child {
  return spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * 递归杀整棵进程树后杀自身。
 * POSIX：pgrep -P 自底向上；Windows：taskkill /PID <pid> /T /F 一次杀整树。
 */
export async function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (IS_WINDOWS) {
    await new Promise<void>((resolve) => {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    return;
  }
  const children = await listChildren(pid);
  for (const childPid of children) {
    await killTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已退出 */
  }
}

/** 等待 pid 退出（带超时）；超时后强杀进程树 */
export async function waitDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const stepMs = 100;
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (!isAlive(pid)) return;
    await sleep(stepMs);
  }
  if (isAlive(pid)) await killTree(pid, 'SIGKILL');
}

/** 列直接子进程 pid（POSIX pgrep -P）；Windows 返回空（taskkill /T 已覆盖整树） */
function listChildren(pid: number): Promise<number[]> {
  if (IS_WINDOWS) return Promise.resolve([]);
  return new Promise((resolve) => {
    const out: string[] = [];
    const child = spawn('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    child.on('exit', () => {
      const pids = out
        .join('')
        .split(/\s+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      resolve(pids);
    });
    child.on('error', () => resolve([]));
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日志文件是否存在 */
export function logExists(logFile: string): boolean {
  return existsSync(logFile);
}
