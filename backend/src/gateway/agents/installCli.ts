import { spawn } from 'node:child_process';
import { ACP_AGENT_KINDS, type AcpAgentKind } from '@linkagent/shared';
import { installGuideFor } from './acpEngine.js';

const INSTALL_TIMEOUT_MS = 8 * 60_000;
const LOG_CAP = 200_000;

export class AgentInstallError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface AgentInstallResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentInstallSpawn = (
  file: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function truncate(s: string): string {
  if (s.length <= LOG_CAP) return s;
  return `${s.slice(0, LOG_CAP)}\n…(已截断)`;
}

function defaultSpawn(file: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new AgentInstallError(`安装超时（>${INSTALL_TIMEOUT_MS / 1000}s）`, 'install_timeout'));
    }, INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new AgentInstallError(err.message || String(err), 'install_spawn_failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: truncate(stdout), stderr: truncate(stderr) });
    });
  });
}

let inflight: Promise<AgentInstallResult> | null = null;

/** 仅执行目录白名单 argv，绝不拼接用户输入。无 argv 的类型请复制命令到本机终端。 */
export async function runAgentInstall(
  type: string,
  opts?: { spawn?: AgentInstallSpawn },
): Promise<AgentInstallResult> {
  if (!ACP_AGENT_KINDS.includes(type as AcpAgentKind)) {
    throw new AgentInstallError(`未知 agent 类型: ${type}`, 'invalid_request');
  }
  const kind = type as AcpAgentKind;
  const guide = installGuideFor(kind);
  const argv = guide.argv;
  if (!argv || argv.length === 0) {
    throw new AgentInstallError(
      `该类型不能由网关代执行安装，请复制命令到本机终端：${guide.command}`,
      'install_not_runnable',
    );
  }
  if (inflight) {
    throw new AgentInstallError('已有安装任务进行中，请稍后再试', 'install_busy');
  }

  const [file, ...args] = argv;
  if (!file) {
    throw new AgentInstallError(`该类型不能由网关代执行安装：${guide.command}`, 'install_not_runnable');
  }

  const run = opts?.spawn ?? defaultSpawn;
  const job = (async () => {
    const { exitCode, stdout, stderr } = await run(file, args);
    return {
      ok: exitCode === 0,
      command: guide.command,
      exitCode,
      stdout,
      stderr,
    };
  })();
  inflight = job;
  try {
    return await job;
  } finally {
    inflight = null;
  }
}
