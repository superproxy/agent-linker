import { taskIdFromHostname, taskPublicHost } from '../../../shared/src/task-host';

/** 边缘代理上任务 Web 的端口。 */
export const TASK_HOST_PORT = 8088;
/** frps HTTP 反向代理端口。任务域名走边缘代理 8088。 */
export const FRPS_VHOST_PORT = 7080;

export interface TaskHostItem {
  id: string;
  name: string;
  agentId: string;
  nodeId?: string;
  cwd?: string;
  key?: string;
  keyEnabled?: boolean;
}

export { taskIdFromHostname as taskLabelFromHostname };

/** 任务号里的下划线在有的解析器里要写成连字符，两种都认。 */
export function matchTaskHost<T extends { id: string }>(tasks: T[], label: string): T | undefined {
  const wanted = new Set([label.toLowerCase(), label.toLowerCase().replace(/-/g, '_')]);
  return tasks.find((task) => wanted.has(task.id.toLowerCase()));
}

function origin(name: string, taskId: string, kind: 'web' | 'ide' | 'dev' | 'vnc', port: number): string {
  const host = taskPublicHost(name, taskId, kind);
  return host ? `http://${host}:${port}/` : '';
}

/** 浏览器打开该任务 Web 的地址，例如 http://test-t_41db7238-web.localhost:8088/ */
export function taskIdeOrigin(name: string, taskId: string, port = TASK_HOST_PORT): string {
  return origin(name, taskId, 'web', port);
}

/** 浏览器打开该任务 code-server 的地址，例如 http://test-t_41db7238-ide.localhost:8088/ */
export function taskCodeServerOrigin(name: string, taskId: string, port = TASK_HOST_PORT): string {
  return origin(name, taskId, 'ide', port);
}

/** 该任务的 npm run dev，例如 http://test-t-41db7238-dev.localhost:8088/ */
export function taskDevOrigin(name: string, taskId: string, port = TASK_HOST_PORT): string {
  return origin(name, taskId, 'dev', port);
}

/** 该任务的 VNC。 */
export function taskVncOrigin(name: string, taskId: string, port = TASK_HOST_PORT): string {
  const host = taskPublicHost(name, taskId, 'vnc');
  return host ? `http://${host}:${port}/vnc.html?autoconnect=1&resize=scale&path=websockify` : '';
}

/** 在线 IDE 里嵌套的 code-server、开发页和 VNC。没有任务时后两者为空。 */
export function taskViewOrigins(
  task: { id: string; name: string } | null | undefined,
  port = TASK_HOST_PORT,
): { ide: string; web: string; vnc: string } {
  const id = task?.id.trim();
  if (!task || !id) return { ide: `http://localhost:${port}/`, web: '', vnc: '' };
  return {
    ide: taskCodeServerOrigin(task.name, id, port),
    web: taskDevOrigin(task.name, id, port),
    vnc: taskVncOrigin(task.name, id, port),
  };
}
