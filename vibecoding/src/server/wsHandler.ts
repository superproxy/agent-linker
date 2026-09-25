import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { Agent, BaseMessage, ServerRequestPayload, ClientCommandPayload, ListAgentsPayload } from '../protocol/index.js';

// 注册的Agent: agentId -> { ws, info }
export const agents = new Map<
  string,
  {
    ws: WebSocket;
    info: Agent;
  }
>();

// 请求映射: requestId -> { resolve, reject, clientWs }
export const pendingRequests = new Map<
  string,
  {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    clientWs: WebSocket;
  }
>();

export async function handleWsMessage(ws: WebSocket, message: BaseMessage) {
  switch (message.type) {
    // Agent注册
    case 'agent:register': {
      const payload = message.payload as any;
      const agentInfo: Agent = {
        agentId: payload.agentId,
        agentName: payload.agentName,
        os: payload.os,
        arch: payload.arch,
        hostname: payload.hostname,
        online: true,
        lastSeen: Date.now(),
      };
      agents.set(payload.agentId, { ws, info: agentInfo });
      console.log(`Agent registered: ${payload.agentId} (${payload.agentName} | ${payload.os} ${payload.arch})`);
      sendMessage(ws, 'server:agent:registered', {
        agentId: payload.agentId,
        serverTime: Date.now(),
      });
      break;
    }

    // Agent心跳
    case 'agent:heartbeat': {
      const payload = message.payload as any;
      const agent = agents.get(payload.agentId);
      if (agent) {
        agent.info.online = true;
        agent.info.lastSeen = Date.now();
      }
      break;
    }

    // Agent返回命令执行结果
    case 'agent:response': {
      const payload = message.payload as { requestId: string; success: boolean; data?: any; error?: string };
      const pending = pendingRequests.get(payload.requestId);
      if (pending) {
        if (payload.success) {
          sendMessage(pending.clientWs, 'server:command:response', payload, payload.requestId);
          pending.resolve(payload.data);
        } else {
          sendMessage(pending.clientWs, 'server:error', {
            code: 500,
            message: payload.error || 'Command execution failed',
          }, payload.requestId);
          pending.reject(new Error(payload.error));
        }
        pendingRequests.delete(payload.requestId);
      }
      break;
    }

    // 客户端请求Agent列表
    case 'client:agent:list': {
      const payload = message.payload as ListAgentsPayload;
      let agentList = Array.from(agents.values()).map(a => a.info);
      if (payload.agentId) {
        agentList = agentList.filter(a => a.agentId === payload.agentId);
      }
      sendMessage(ws, 'server:agent:list', { agents: agentList }, message.requestId);
      break;
    }

    // 客户端发送命令到Agent
    case 'client:command': {
      const payload = message.payload as ClientCommandPayload;
      const agent = agents.get(payload.agentId);
      if (!agent || !agent.info.online) {
        sendMessage(ws, 'server:error', { code: 404, message: 'Agent not found or offline' }, message.requestId);
        return;
      }

      const requestId = message.requestId || uuidv4();

      // 创建pending请求
      const promise = new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject, clientWs: ws });
        // 超时
        setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            sendMessage(ws, 'server:error', { code: 408, message: 'Command timeout' }, requestId);
            reject(new Error('Command timeout'));
          }
        }, 30000);
      });

      // 转发请求到Agent
      sendMessage(agent.ws, 'server:request', {
        command: payload.command,
        params: payload.params,
      } as ServerRequestPayload, requestId);

      try {
        await promise;
      } catch (err) {
        // 错误已经发送给客户端了
      }
      break;
    }

    default:
      console.warn('Unknown message type:', message.type);
  }
}

export function handleWsDisconnect(ws: WebSocket) {
  // 检查是否是Agent断开
  for (const [agentId, agent] of agents.entries()) {
    if (agent.ws === ws) {
      agent.info.online = false;
      console.log(`Agent ${agentId} (${agent.info.agentName}) disconnected`);
      // 30秒后还没上线就移除
      setTimeout(() => {
        if (agents.get(agentId)?.info.online === false) {
          agents.delete(agentId);
        }
      }, 30000);
      break;
    }
  }
  // 清理该连接相关的pending请求
  for (const [requestId, req] of pendingRequests.entries()) {
    if (req.clientWs === ws) {
      req.reject(new Error('Client disconnected'));
      pendingRequests.delete(requestId);
    }
  }
}

function sendMessage<T>(ws: WebSocket, type: string, payload: T, requestId?: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const message: BaseMessage<T> = { type: type as any, payload, requestId };
  ws.send(JSON.stringify(message));
}
