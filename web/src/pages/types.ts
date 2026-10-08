import type { AuthErrorHandler } from '../lib/hooks';

export interface PageProps {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  isAdmin?: boolean;
}

/** 从任务管理跳入对话页时携带的持久会话上下文 */
export interface ChatSession {
  channel: string;
  userId: string;
  ownerUsername?: string;
  taskId: string;
  taskName: string;
  agentId: string;
  nodeId?: string;
  key?: string;
  keyEnabled?: boolean;
  /** 展示用。文件与终端的根目录由服务端按任务记录解析，不采用这里的值 */
  cwd?: string;
}
