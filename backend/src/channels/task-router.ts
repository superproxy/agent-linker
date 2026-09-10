/**
 * bot 路由层（每个渠道一份实例）：维护"当前选中任务"内存缓存，
 * 网关 /api/tasks 的 activeTaskId 为单一事实源，本层只是缓存 + 失效。
 */
export interface TaskRouterOptions {
  /** 网关 base（http://127.0.0.1:8787） */
  gatewayUrl: string;
  /** 渠道标识（weixin / wecom） */
  channel: string;
}

export interface ActiveRoute {
  agent: string;
  task: string;
}

export class TaskRouter {
  private readonly gatewayUrl: string;
  private readonly channel: string;
  private readonly cache = new Map<string, ActiveRoute>();

  constructor(options: TaskRouterOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.channel = options.channel;
  }

  /** 是否任务命令（/task 前缀；与网关 isTaskCommand 对齐） */
  static isCommand(text: string): boolean {
    const t = text.trim().toLowerCase();
    return t === '/task' || t.startsWith('/task ');
  }

  /** 当前选中任务（缓存命中直接返回；未命中查 /api/tasks，取激活任务，兜底 default+opencode） */
  async active(userId: string): Promise<ActiveRoute> {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    let route: ActiveRoute = { agent: 'opencode', task: 'default' };
    try {
      const url = `${this.gatewayUrl}/api/tasks?channel=${encodeURIComponent(this.channel)}&userId=${encodeURIComponent(userId)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          activeTaskId?: string;
          tasks?: Array<{ id: string; agentId: string }>;
        };
        const activeId = data.activeTaskId || data.tasks?.[0]?.id || 'default';
        const active = data.tasks?.find((t) => t.id === activeId);
        route = { agent: active?.agentId ?? 'opencode', task: activeId };
      }
    } catch {
      // 查询失败回落默认路由，不阻断消息
    }
    this.cache.set(userId, route);
    return route;
  }

  /** 命令处理后失效缓存（下次普通消息重新查询） */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
