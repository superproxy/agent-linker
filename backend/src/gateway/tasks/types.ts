/** 任务（一个任务 = 一个绑定特定 agent 的持久会话） */
export interface TaskItem {
  id: string;
  name: string;
  agentId: string;
  createdAt: number;
}

/** 单个渠道用户的全部任务状态（网关为单一事实源，落盘） */
export interface UserTasks {
  channel: string;
  userId: string;
  /** 当前激活任务 id（web 点击 / 微信命令都写这里） */
  activeTaskId: string;
  tasks: TaskItem[];
}

/** 路由解析结果：普通消息发往的 agent + 会话任务 */
export interface TaskRoute {
  agentId: string;
  taskId: string;
  taskName: string;
}

/** /task 命令处理结果 */
export interface CommandResult {
  text: string;
  /** 命令导致激活变化时带回（供 bot 同步，可选） */
  activeTaskId?: string;
  activeAgentId?: string;
}

export const TASK_COMMAND_PREFIX = '/task';
export const DEFAULT_TASK_ID = 'default';
export const DEFAULT_TASK_NAME = '默认';
export const DEFAULT_AGENT_ID = 'opencode';
/** 命令里可识别的 agent 别名（new 的第二个可选参数） */
export const KNOWN_AGENT_IDS = ['pi', 'opencode'] as const;
