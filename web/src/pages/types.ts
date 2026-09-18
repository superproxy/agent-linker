import type { AuthErrorHandler } from '../lib/hooks';

export interface PageProps {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
}

/** 从任务管理跳入对话页时携带的持久会话上下文 */
export interface ChatSession {
  channel: string;
  userId: string;
  taskId: string;
  taskName: string;
  agentId: string;
  nodeId?: string;
  key?: string;
  keyEnabled?: boolean;
}
