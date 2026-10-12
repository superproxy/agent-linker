import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { ensureTaskCwdExists } from '../util/task-paths.js';
import { nodeRunsInsideIdeContainer } from './dev-port.js';

/** 与 ACP 一样：一条命令、一个工作目录，由节点进程拉起。 */
export interface TaskProcessSpec {
  id: string;
  command: string[];
}

export interface SpawnedTaskProcess {
  kill: () => void;
}

export type TaskProcessSpawn = (command: string[], cwd: string) => SpawnedTaskProcess;

/** 聚合容器把 dev 交给节点。入口脚本看到 LINKAGENT_DEV_BY_NODE=1 时不再占 5173。 */
export function devOwnedByNode(flag: string | undefined): boolean {
  const raw = (flag ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * 容器内 dev：工作区没有 vite 时先安装，再听 0.0.0.0:5173。
 * 只在 LINKAGENT_DEV_BY_NODE 且 node.taskProcesses 为空时使用。
 */
export function dockerDevProcess(): TaskProcessSpec {
  return {
    id: 'dev',
    command: [
      'sh',
      '-c',
      [
        'root="${LINKAGENT_NODE_WORKSPACE:-/root/workspace}"',
        'if [ ! -f package.json ]; then',
        '  found=""',
        '  for d in "$root"/*; do',
        '    if [ -f "$d/package.json" ]; then',
        '      if [ -n "$found" ]; then found=""; break; fi',
        '      found="$d"',
        '    fi',
        '  done',
        '  if [ -n "$found" ]; then cd "$found" || exit 0; fi',
        'fi',
        'if [ ! -f package.json ]; then echo "[node] 任务目录没有 package.json，跳过 dev"; exit 0; fi',
        'if [ ! -x node_modules/.bin/vite ]; then npm install; fi',
        'task=$(cat /etc/linkagent/current-task 2>/dev/null || true)',
        'host="${LINKAGENT_PUBLIC_HOST:-}"',
        'cfg=""',
        'for name in vite.config.ts vite.config.js vite.config.mjs; do',
        '  if [ -f "$name" ]; then cfg="$PWD/$name"; break; fi',
        'done',
        'if [ -n "$task" ] && [ -n "$host" ] && [ -n "$cfg" ]; then',
        '  cat > "$PWD/node_modules/.linkagent-vite.config.mjs" << EOF',
        'import { defineConfig, mergeConfig } from "vite";',
        'import config from "$cfg";',
        'export default mergeConfig(config, defineConfig({ base: "/$task/", server: { allowedHosts: true, host: true, port: 5173, strictPort: true } }));',
        'EOF',
        '  exec npx vite --config "$PWD/node_modules/.linkagent-vite.config.mjs" --host 0.0.0.0 --port 5173 --strictPort',
        'fi',
        'exec npm run dev -- --host 0.0.0.0 --port 5173 --strictPort',
      ].join('\n'),
    ],
  };
}

/** 节点本机命令优先。容器标志打开且未配置时，用 {@link dockerDevProcess}。 */
export function taskProcessesFromConfig(
  configured: readonly TaskProcessSpec[],
  devByNodeFlag: string | undefined,
): TaskProcessSpec[] {
  if (configured.length > 0) return configured.map((spec) => ({ id: spec.id, command: [...spec.command] }));
  if (!devOwnedByNode(devByNodeFlag)) return [];
  if (nodeRunsInsideIdeContainer()) return [dockerDevProcess()];
  return [];
}

function slash(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 网关记下的是宿主机目录。聚合容器把 `<工作区>/<用户>` 挂到 LINKAGENT_NODE_WORKSPACE，
 * 任务目录在容器里是 `<workspace>/<taskId>`。已经在这个根下的路径原样使用。
 */
export function resolveNodeTaskCwd(cwd: string, workspaceRoot: string | undefined, taskId?: string): string {
  const dir = cwd.trim();
  const root = workspaceRoot?.trim();
  if (!root) return dir;
  const nRoot = slash(root);
  const nDir = slash(dir);
  if (nDir === nRoot || nDir.startsWith(`${nRoot}/`)) return dir;
  const leaf = (taskId?.trim() || basename(dir)).replace(/[\\/]/g, '');
  if (!leaf || leaf === '.' || leaf === '..') return dir;
  return join(root, leaf);
}

/**
 * 切换时实际要拉起的命令。消息里带了 processes 就用消息的（含空数组）；
 * 没带则用节点本机配置，和 ACP 用 node.agents.command 一样。
 */
export function resolveTaskSwitchProcesses(
  configured: readonly TaskProcessSpec[],
  fromMessage: readonly TaskProcessSpec[] | undefined,
): TaskProcessSpec[] {
  const source = fromMessage ?? configured;
  const out: TaskProcessSpec[] = [];
  for (const spec of source) {
    const id = spec.id.trim();
    const command = spec.command.map((part) => part.trim()).filter((part) => part.length > 0);
    if (!id || command.length === 0) continue;
    out.push({ id, command });
  }
  return out;
}

function defaultSpawn(command: string[], cwd: string): SpawnedTaskProcess {
  const [bin, ...args] = command;
  if (!bin) return { kill() {} };
  const logDev = bin === 'powershell' || bin === 'sh';
  const child = spawn(bin, args, {
    cwd,
    stdio: logDev ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    windowsHide: true,
  });
  if (logDev) {
    const tag = '[dev]';
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) console.log(`${tag} ${line}`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) console.error(`${tag} ${line}`);
      }
    });
    child.on('exit', (code, signal) => {
      if (code && code !== 0) {
        console.error(`${tag} 退出 code=${String(code)} signal=${signal ?? '-'} cwd=${cwd}`);
      }
    });
  }
  return {
    kill() {
      child.kill();
    },
  };
}

/**
 * 当前任务的附属进程。切换任务时先停掉上一组，再在新目录启动。
 * 同一 taskId 不重启。任务目录创建走 {@link ensureTaskCwdExists}。
 */
export class TaskProcessGroup {
  private taskId = '';
  private readonly children: { id: string; kill: () => void }[] = [];

  constructor(private readonly spawnFn: TaskProcessSpawn = defaultSpawn) {}

  currentTaskId(): string {
    return this.taskId;
  }

  switchTo(taskId: string, cwd: string, processes: readonly TaskProcessSpec[]): void {
    const id = taskId.trim();
    if (!id) throw new Error('taskId 不能为空');
    const sameTask = id === this.taskId;
    if (sameTask && processes.length === 0) return;
    if (sameTask) {
      for (const child of this.children) {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }
      this.children.length = 0;
    } else {
      this.stop();
      this.taskId = id;
    }
    const dir = ensureTaskCwdExists(cwd);
    if (!sameTask) this.taskId = id;
    for (const spec of processes) {
      const command = spec.command.map((part) => part.trim()).filter((part) => part.length > 0);
      const bin = command[0];
      if (!bin) continue;
      const child = this.spawnFn(command, dir);
      this.children.push({ id: spec.id, kill: () => child.kill() });
    }
  }

  stop(): void {
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        /* 进程已退出 */
      }
    }
    this.children.length = 0;
    this.taskId = '';
  }
}
