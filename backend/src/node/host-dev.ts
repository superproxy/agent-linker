import { taskViteBasePath } from '@linkagent/shared';
import type { TaskProcessSpec } from './task-processes.js';
import { devOwnedByNode, normalizeContainerDevProcesses } from './task-processes.js';
import {
  nodeRunsInsideIdeContainer,
  pickFreePort,
  readDevPortState,
  writeDevPortState,
  type DevPortState,
} from './dev-port.js';
import { SAAS_DEV_LISTEN, setSaasDevTargetPort } from './saas-path.js';

function stackEnhanceIdeEnabled(): boolean {
  const raw = (process.env.LINKAGENT_LOCAL_STACK_ENHANCE ?? process.env.LINKAGENT_SERVE_WEB_ENHANCE ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function shouldAllocateHostDev(devByNodeFlag: string | undefined, pathRouting: boolean): boolean {
  if (nodeRunsInsideIdeContainer()) return false;
  if (devOwnedByNode(devByNodeFlag)) return true;
  if (stackEnhanceIdeEnabled()) return true;
  /** 路径 frpc（15173 适配器）下 dev 必须在宿主机，不能依赖容器 5173。 */
  if (pathRouting) return true;
  return false;
}

/** 供 sh 嵌入：exec vite / npm run dev（路径模式用 CLI --base，避免 merge 函数式 vite.config）。 */
export function buildHostDevShellBody(taskId: string, port: number, publicHost: string, pathRouting: boolean): string {
  const baseArg =
    pathRouting && publicHost.trim().length > 0 ? ` --base ${taskViteBasePath(taskId).replace(/'/g, '')}` : '';
  const hostArg = pathRouting && publicHost.trim().length > 0 ? ' --allowedHosts true' : '';
  return [
    'if [ ! -f package.json ]; then echo "[dev] 任务目录没有 package.json，跳过"; exit 0; fi',
    `exec npm run dev -- --host 127.0.0.1 --port ${port} --strictPort${hostArg}${baseArg}`,
  ].join('\n');
}

/** Windows：PowerShell 启动 dev（路径模式用 CLI --base）。 */
export function buildHostDevPowerShellBody(taskId: string, port: number, publicHost: string, pathRouting: boolean): string {
  const baseArg =
    pathRouting && publicHost.trim().length > 0
      ? ` --base ${taskViteBasePath(taskId).replace(/"/g, '`"')}`
      : '';
  const hostArg = pathRouting && publicHost.trim().length > 0 ? ' --allowedHosts true' : '';
  return `
if (-not (Test-Path package.json)) { Write-Host '[dev] 任务目录没有 package.json，跳过'; exit 0 }
& npm run dev -- --host 127.0.0.1 --port ${port} --strictPort${hostArg}${baseArg}
`.trim();
}

export function hostDevProcessSpec(taskId: string, port: number, publicHost: string, pathRouting: boolean): TaskProcessSpec {
  if (process.platform === 'win32') {
    return {
      id: 'dev',
      command: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', buildHostDevPowerShellBody(taskId, port, publicHost, pathRouting)],
    };
  }
  return {
    id: 'dev',
    command: ['sh', '-c', buildHostDevShellBody(taskId, port, publicHost, pathRouting)],
  };
}

/**
 * 切换任务时：若未配置 taskProcesses，则在宿主机选口、写 dev-port.json、让 15173 适配器指向该口。
 */
export async function augmentTaskProcessesWithHostDev(input: {
  taskId: string;
  runtimeDir: string;
  configured: readonly TaskProcessSpec[];
  fromMessage: readonly TaskProcessSpec[] | undefined;
  devByNodeFlag: string | undefined;
  publicHost: string;
  pathRouting: boolean;
}): Promise<TaskProcessSpec[]> {
  const fromMessage = input.fromMessage;
  const hasExplicitList = fromMessage !== undefined;
  if (hasExplicitList) {
    const explicit = fromMessage
      .map((spec) => ({
        id: spec.id.trim(),
        command: spec.command.map((p) => p.trim()).filter((p) => p.length > 0),
      }))
      .filter((spec) => spec.id && spec.command.length > 0);
    return normalizeContainerDevProcesses(explicit, input.devByNodeFlag);
  }
  if (input.configured.length > 0) {
    return normalizeContainerDevProcesses(input.configured, input.devByNodeFlag);
  }
  if (!shouldAllocateHostDev(input.devByNodeFlag, input.pathRouting)) {
    return normalizeContainerDevProcesses([], input.devByNodeFlag);
  }

  const port = await pickFreePort();
  setSaasDevTargetPort(port);
  const state: DevPortState = {
    taskId: input.taskId.trim(),
    port,
    listen: '127.0.0.1',
    adapterPort: SAAS_DEV_LISTEN,
    updatedAt: Date.now(),
  };
  writeDevPortState(input.runtimeDir, state);
  console.log(
    `[node] dev 127.0.0.1:${port} taskId=${state.taskId}（frpc → ${SAAS_DEV_LISTEN} → ${port}，已写 dev-port.json）`,
  );
  return [hostDevProcessSpec(state.taskId, port, input.publicHost, input.pathRouting)];
}

/** 启动时从 dev-port.json 恢复适配器 upstream（同 task 重启 node 时）。 */
export function restoreDevPortFromRuntime(runtimeDir: string): void {
  const saved = readDevPortState(runtimeDir);
  if (saved) setSaasDevTargetPort(saved.port);
}
