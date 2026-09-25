import { z } from 'zod';
import type { CommandType } from './index.js';

/** SubAgent类型 */
export enum SubAgentType {
  /** 级联模式子Agent：内网其他机器的Agent */
  CASCADE = 'cascade',
  /** 功能模式子Agent：按功能拆分的子Agent */
  FUNCTION = 'function',
}

/** SubAgent元信息 */
export const SubAgentSchema = z.object({
  subAgentId: z.string(),
  subAgentName: z.string(),
  type: z.nativeEnum(SubAgentType),
  os: z.enum(['linux', 'darwin', 'win32']),
  arch: z.enum(['x64', 'arm64', 'ia32']),
  hostname: z.string(),
  online: z.boolean(),
  lastSeen: z.number(),
  // 支持的命令列表，空表示支持所有
  supportedCommands: z.array(z.nativeEnum(CommandType)).optional(),
  // 级联模式：子Agent的内网地址
  cascadeAddr: z.string().optional(),
});
export type SubAgent = z.infer<typeof SubAgentSchema>;

/** SubAgent相关消息类型 */
export enum SubAgentMessageType {
  // 子Agent -> 主Agent 消息
  SUBAGENT_REGISTER = 'subagent:register',
  SUBAGENT_HEARTBEAT = 'subagent:heartbeat',
  SUBAGENT_RESPONSE = 'subagent:response',

  // 主Agent -> 子Agent 消息
  SUBAGENT_REGISTERED = 'subagent:registered',
  SUBAGENT_REQUEST = 'subagent:request',

  // 客户端/服务端 -> 主Agent 消息
  SUBAGENT_LIST = 'subagent:list',
  SUBAGENT_SEND_COMMAND = 'subagent:command',
}
