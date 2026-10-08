import { taskIdFromHostname, taskPublicHost } from '../../../shared/src/task-host';

/** 边缘代理上任务 Web 的端口。 */
export const TASK_HOST_PORT = 8088;

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

function origin(name: string, taskId: string, kind: 'web' | 'ide', port: number): string {
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

/** 在线 IDE 里嵌套的 IDE 视图与任务 Web。没有任务时 IDE 视图用固定的 code-server 入口。 */
export function taskViewOrigins(
  task: { id: string; name: string } | null | undefined,
  port = TASK_HOST_PORT,
): { ide: string; web: string | null } {
  const id = task?.id.trim();
  if (!task || !id) return { ide: `http://localhost:${port}/`, web: null };
  return {
    ide: taskCodeServerOrigin(task.name, id, port),
    web: taskIdeOrigin(task.name, id, port),
  };
}
