import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  MessageType,
  type BaseMessage,
  type Agent,
  type CommandType,
  type FileEntry,
  type ProcessEntry,
  type SystemStatus,
} from '../protocol/index.js';

export class VibeCodingClient {
  private ws: WebSocket;
  private requestHandlers = new Map<string, (res: any, err?: Error) => void>();
  private connected = false;
  private connectPromise: Promise<void>;

  constructor(serverUrl: string = 'ws://127.0.0.1:9999') {
    this.ws = new WebSocket(serverUrl);
    this.connectPromise = new Promise((resolve) => {
      this.ws.on('open', () => {
        this.connected = true;
        console.log('Connected to VibeCoding server');
        resolve();
      });
    });
    this.setupEventListeners();
  }

  waitForConnect(): Promise<void> {
    return this.connectPromise;
  }

  private setupEventListeners() {
    this.ws.on('message', (data) => {
      const message: BaseMessage = JSON.parse(data.toString());
      this.handleMessage(message);
    });

    this.ws.on('close', () => {
      this.connected = false;
      console.log('Disconnected from VibeCoding server');
      // 清理所有pending请求
      for (const [requestId, handler] of this.requestHandlers.entries()) {
        handler(null, new Error('Connection closed'));
        this.requestHandlers.delete(requestId);
      }
    });

    this.ws.on('error', (err) => {
      console.error('VibeCoding client error:', err);
    });
  }

  private handleMessage(message: BaseMessage) {
    // 处理请求响应
    if (message.requestId && this.requestHandlers.has(message.requestId)) {
      const handler = this.requestHandlers.get(message.requestId)!;
      if (message.type === MessageType.SERVER_ERROR) {
        handler(null, new Error((message.payload as any).message));
      } else {
        handler(message.payload);
      }
      this.requestHandlers.delete(message.requestId);
      return;
    }
  }

  private sendRequest<T>(type: MessageType, payload: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error('Not connected to server'));
      }
      const requestId = uuidv4();
      this.requestHandlers.set(requestId, (data, err) => {
        if (err) reject(err);
        else resolve(data);
      });
      const message: BaseMessage = { type, payload, requestId };
      this.ws.send(JSON.stringify(message));

      // 超时
      setTimeout(() => {
        if (this.requestHandlers.has(requestId)) {
          this.requestHandlers.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  /** 获取所有在线Agent列表 */
  async listAgents(agentId?: string): Promise<Agent[]> {
    const res = await this.sendRequest<{ agents: Agent[] }>(MessageType.CLIENT_LIST_AGENTS, { agentId });
    return res.agents;
  }

  /** 发送命令到指定Agent */
  async sendCommand<T = any>(agentId: string, command: CommandType, params: Record<string, any> = {}): Promise<T> {
    const res = await this.sendRequest<{ success: boolean; data: T; error?: string }>(
      MessageType.CLIENT_SEND_COMMAND,
      { agentId, command, params }
    );
    return res.data;
  }

  // ========== 快捷方法：文件管理 ==========
  async fileList(agentId: string, path: string = '.'): Promise<FileEntry[]> {
    return this.sendCommand(agentId, 'file:list', { path });
  }

  async fileStat(agentId: string, path: string): Promise<FileEntry> {
    return this.sendCommand(agentId, 'file:stat', { path });
  }

  async fileRead(agentId: string, path: string, encoding: BufferEncoding = 'base64'): Promise<string> {
    return this.sendCommand(agentId, 'file:read', { path, encoding });
  }

  async fileWrite(agentId: string, path: string, content: string | Buffer, encoding: BufferEncoding = 'base64'): Promise<{ success: boolean }> {
    const contentStr = Buffer.isBuffer(content) ? content.toString(encoding) : content;
    return this.sendCommand(agentId, 'file:write', { path, content: contentStr, encoding });
  }

  async fileDelete(agentId: string, path: string): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'file:delete', { path });
  }

  async fileRename(agentId: string, oldPath: string, newPath: string): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'file:rename', { oldPath, newPath });
  }

  async fileMkdir(agentId: string, path: string, recursive: boolean = true): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'file:mkdir', { path, recursive });
  }

  // ========== 快捷方法：进程/系统管理 ==========
  async processList(agentId: string): Promise<ProcessEntry[]> {
    return this.sendCommand(agentId, 'process:list');
  }

  async processKill(agentId: string, pid: number, signal: string = 'SIGTERM'): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'process:kill', { pid, signal });
  }

  async systemStatus(agentId: string): Promise<SystemStatus> {
    return this.sendCommand(agentId, 'system:status');
  }

  // ========== 快捷方法：服务管理 ==========
  async serviceList(agentId: string): Promise<any[]> {
    return this.sendCommand(agentId, 'service:list');
  }

  async serviceStart(agentId: string, name: string): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'service:start', { name });
  }

  async serviceStop(agentId: string, name: string): Promise<{ success: boolean }> {
    return this.sendCommand(agentId, 'service:stop', { name });
  }

  // ========== 快捷方法：远程桌面 ==========
  async desktopScreenshot(agentId: string): Promise<string> {
    // 返回base64编码的PNG图片
    return this.sendCommand(agentId, 'desktop:screenshot');
  }

  /** 关闭客户端连接 */
  close(): void {
    this.ws.close();
    this.requestHandlers.clear();
  }
}
