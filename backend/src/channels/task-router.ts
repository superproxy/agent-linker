/**
 * bot 路由层（每个渠道一份实例）：维护"当前选中任务"内存缓存，
 * 网关 /api/tasks 的 activeTaskId 为单一事实源，本层只是缓存 + 失效。
 *
 * 缓存一致性：仅靠 /task 命令后 invalidate 不够——控制台等外部入口直接 PATCH
 * /api/tasks 切任务时不会通知本层，旧缓存会把后续消息路由到旧任务（"切了任务却
 * 回到默认智能体"）。因此缓存带 TTL：外部切换后最迟 CACHE_TTL_MS 内生效；
 * 查询失败时不写缓存（下次消息重试），避免网关抖动把 fallback 路由钉死。
 */
export interface TaskRouterOptions {
  /** 网关 base（http://127.0.0.1:8787） */
  gatewayUrl: string;
  /** 渠道标识（目前仅 weixin 使用任务路由；wecom 等渠道无任务机制） */
  channel: string;
}

export interface ActiveRoute {
  /** 任务绑定的 agent；无明确绑定/查询失败时为 undefined → 不向网关透传，由网关按 defaultAgentId 权威兜底 */
  agent?: string;
  task: string;
}

/** 路由缓存有效期：外部（控制台等）切换任务后，普通消息最迟该时长内按新激活任务路由 */
const CACHE_TTL_MS = 2_000;

export class TaskRouter {
  private readonly gatewayUrl: string;
  private readonly channel: string;
  private readonly cache = new Map<string, { route: ActiveRoute; at: number }>();

  constructor(options: TaskRouterOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.channel = options.channel;
  }

  /** 是否任务命令（/task 前缀；与网关 isTaskCommand 对齐） */
  static isCommand(text: string): boolean {
    const t = text.trim().toLowerCase();
    return t === '/task' || t.startsWith('/task ');
  }

  /** 当前选中任务（缓存未过期直接返回；过期/未命中查 /api/tasks，取激活任务及其绑定的 agent） */
  async active(userId: string): Promise<ActiveRoute> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.route;
    // 查询失败/无任务：只回落默认任务 id，不指定 agent（网关按 defaultAgentId 权威兜底）
    let route: ActiveRoute = { task: 'default' };
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
        // agent 取任务真实绑定；tasks 为空/activeId 不在列表时为 undefined（网关权威兜底 defaultAgentId）
        route = { agent: active?.agentId, task: activeId };
        // 仅成功结果入缓存；失败回落默认路由但不缓存，下次消息重试
        this.cache.set(userId, { route, at: Date.now() });
      }
    } catch {
      // 查询失败回落默认路由，不阻断消息
    }
    return route;
  }

  /** 命令处理后失效缓存（下次普通消息重新查询） */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
