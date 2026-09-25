import { z } from 'zod';

/** Agent元数据 */
export const AgentSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  os: z.enum(['linux', 'darwin', 'win32']),
  arch: z.enum(['x64', 'arm64', 'ia32']),
  hostname: z.string(),
  online: z.boolean(),
  lastSeen: z.number(),
  /** 父AgentID，为空则是直连服务端的根Agent */
  parentAgentId: z.string().optional(),
  /** 子Agent列表，用于展示拓扑 */
  children: z.array(z.lazy(() => AgentSchema)).optional(),
  /** 是否是中继Agent（支持接收子Agent连接） */
  isRelay: z.boolean().default(false),
});
export type Agent = z.infer<typeof AgentSchema>;

/** 通信消息类型 */
export enum MessageType {
  //  Agent -> Server 消息
  AGENT_REGISTER = 'agent:register',
  AGENT_HEARTBEAT = 'agent:heartbeat',
  AGENT_RESPONSE = 'agent:response',
  // 中继Agent上报子Agent
  AGENT_SUBAGENT_REGISTER = 'agent:subagent:register',
  AGENT_SUBAGENT_HEARTBEAT = 'agent:subagent:heartbeat',
  AGENT_SUBAGENT_DISCONNECT = 'agent:subagent:disconnect',
  // 中继Agent转发子Agent消息到服务端
  AGENT_RELAY_MESSAGE = 'agent:relay:message',

  // Server -> Agent 消息
  SERVER_AGENT_REGISTERED = 'server:agent:registered',
  SERVER_REQUEST = 'server:request',
  // 服务端转发消息给中继Agent，再转给子Agent
  SERVER_RELAY_MESSAGE = 'server:relay:message',

  // Client -> Server 消息
  CLIENT_LIST_AGENTS = 'client:agent:list',
  CLIENT_SEND_COMMAND = 'client:command',
  CLIENT_GET_TOPOLOGY = 'client:topology:get',

  // Server -> Client 消息
  SERVER_AGENT_LIST = 'server:agent:list',
  SERVER_TOPOLOGY = 'server:topology',
  SERVER_COMMAND_RESPONSE = 'server:command:response',
  SERVER_ERROR = 'server:error',
}

/** 命令类型 */
export enum CommandType {
  // 文件管理命令
  FILE_LIST = 'file:list',
  FILE_READ = 'file:read',
  FILE_WRITE = 'file:write',
  FILE_DELETE = 'file:delete',
  FILE_RENAME = 'file:rename',
  FILE_MKDIR = 'file:mkdir',
  FILE_STAT = 'file:stat',

  // 进程/服务管理命令
  PROCESS_LIST = 'process:list',
  PROCESS_KILL = 'process:kill',
  SERVICE_LIST = 'service:list',
  SERVICE_START = 'service:start',
  SERVICE_STOP = 'service:stop',
  SYSTEM_STATUS = 'system:status',

  // 远程桌面命令
  DESKTOP_SCREENSHOT = 'desktop:screenshot',
  DESKTOP_MOUSE_EVENT = 'desktop:mouse',
  DESKTOP_KEYBOARD_EVENT = 'desktop:keyboard',
}

/** 基础消息结构 */
export interface BaseMessage<T = unknown> {
  type: MessageType;
  requestId?: string;
  payload: T;
}

// 消息Payload类型
export interface AgentRegisterPayload {
  agentId: string;
  agentName: string;
  os: Agent['os'];
  arch: Agent['arch'];
  hostname: string;
  supportedFeatures: CommandType[];
}

export interface AgentRegisteredPayload {
  agentId: string;
  serverTime: number;
}

export interface AgentHeartbeatPayload {
  agentId: string;
  systemLoad: {
    cpu: number;
    memory: number;
    disk: number;
  };
}

export interface ServerRequestPayload {
  command: CommandType;
  params: Record<string, any>;
}

export interface AgentResponsePayload {
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface ClientCommandPayload {
  agentId: string;
  command: CommandType;
  params: Record<string, any>;
}

export interface ListAgentsPayload {
  agentId?: string;
}

export interface AgentListPayload {
  agents: Agent[];
}

export interface ErrorPayload {
  code: number;
  message: string;
  requestId?: string;
}

// 文件管理相关类型
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  mode: number;
}

// 进程相关类型
export interface ProcessEntry {
  pid: number;
  name: string;
  cmdline: string;
  cpu: number;
  memory: number;
  user: string;
  startTime: number;
}

// 系统状态类型
export interface SystemStatus {
  cpu: {
    usage: number;
    cores: number;
    model: string;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usage: number;
    mountPoint: string;
  }[];
  network: {
    rxBytes: number;
    txBytes: number;
  };
  uptime: number;
}
