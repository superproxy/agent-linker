import { TASK_PUBLIC_HOST, taskIdFromHostname, taskIdFromPublicPath, taskPublicPath } from '../../../shared/src/task-host';

/** 边缘代理上任务 Web 的端口。 */
export const TASK_HOST_PORT = 9080;
/** frps HTTP 反向代理端口。任务域名走边缘代理 9080。 */
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

export { taskIdFromHostname as taskLabelFromHostname, taskIdFromPublicPath };

/** 任务号里的下划线在有的解析器里要写成连字符，两种都认。 */
export function matchTaskHost<T extends { id: string }>(tasks: T[], label: string): T | undefined {
  const wanted = new Set([label.toLowerCase(), label.toLowerCase().replace(/-/g, '_')]);
  return tasks.find((task) => wanted.has(task.id.toLowerCase()));
}

export interface TaskPublicEndpoint {
  host: string;
  port: number;
}

let loadedEndpoint: TaskPublicEndpoint = { host: TASK_PUBLIC_HOST, port: TASK_HOST_PORT };

/** 网关 `/api/edge` 加载到的正式域名。 */
export function setTaskPublicEndpoint(endpoint: TaskPublicEndpoint): void {
  const host = endpoint.host.trim();
  const port = endpoint.port;
  if (!host || !Number.isInteger(port) || port <= 0) return;
  loadedEndpoint = { host, port };
}

export function taskPublicEndpoint(): TaskPublicEndpoint {
  return loadedEndpoint;
}

function endpointOf(port?: number, host?: string): TaskPublicEndpoint {
  return {
    host: host?.trim() || loadedEndpoint.host,
    port: port ?? loadedEndpoint.port,
  };
}

function originOf(endpoint: TaskPublicEndpoint): string {
  if (endpoint.port === 443) return `https://${endpoint.host}`;
  if (endpoint.port === 80) return `http://${endpoint.host}`;
  return `http://${endpoint.host}:${endpoint.port}`;
}

function publicUrl(taskId: string, type: 'web' | 'code' | 'vnc', port?: number, host?: string): string {
  const path = taskPublicPath(taskId, type);
  return path ? `${originOf(endpointOf(port, host))}${path}` : '';
}

/** 浏览器打开该任务 Web，例如 http://ide.localhost:9080/t_41db7238-web */
export function taskIdeOrigin(_name: string, taskId: string, port?: number, host?: string): string {
  return publicUrl(taskId, 'web', port, host);
}

/** 浏览器打开该任务 code-server，例如 http://ide.localhost:9080/t_41db7238-code */
export function taskCodeServerOrigin(_name: string, taskId: string, port?: number, host?: string): string {
  return publicUrl(taskId, 'code', port, host);
}

/** 与 Web 入口相同。 */
export function taskDevOrigin(name: string, taskId: string, port?: number, host?: string): string {
  return taskIdeOrigin(name, taskId, port, host);
}

/** 该任务的 VNC。WebSocket 路径留在同一条 `/<taskId>-vnc` 下。 */
export function taskVncOrigin(_name: string, taskId: string, port?: number, host?: string): string {
  const path = taskPublicPath(taskId, 'vnc');
  if (!path) return '';
  const socket = `${taskId.trim()}-vnc/websockify`;
  const base = originOf(endpointOf(port, host));
  return `${base}${path}/vnc.html?autoconnect=1&resize=scale&path=${encodeURIComponent(socket)}`;
}

/** 在线 IDE 里嵌套的 code-server、开发页和 VNC。没有任务时后两者为空。 */
export function taskViewOrigins(
  task: { id: string; name: string } | null | undefined,
  port?: number,
): { ide: string; web: string; vnc: string } {
  const id = task?.id.trim();
  if (!task || !id) return { ide: `${originOf(endpointOf(port))}/`, web: '', vnc: '' };
  return {
    ide: taskCodeServerOrigin(task.name, id, port),
    web: taskDevOrigin(task.name, id, port),
    vnc: taskVncOrigin(task.name, id, port),
  };
}
