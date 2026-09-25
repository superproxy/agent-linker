import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { platform, arch, hostname } from 'node:os';
import {
  MessageType,
  type BaseMessage,
  type AgentRegisterPayload,
  type ServerRequestPayload,
} from '../protocol/index.js';
import { PluginManager } from './plugin-manager.js';

const SERVER_URL = process.env.VIBECODING_SERVER || 'ws://127.0.0.1:9999';
const AGENT_ID = process.env.VIBECODING_AGENT_ID || `agent-${uuidv4().slice(0, 8)}`;
const AGENT_NAME = process.env.VIBECODING_AGENT_NAME || hostname();
const OS = platform() as 'linux' | 'darwin' | 'win32';
const ARCH = arch() as 'x64' | 'arm64' | 'ia32';
const HOSTNAME = hostname();

console.log(`VibeCoding agent starting, connecting to ${SERVER_URL}...`);
console.log(`Agent ID: ${AGENT_ID}, Name: ${AGENT_NAME}, OS: ${OS}, Arch: ${ARCH}`);

let ws: WebSocket;
let heartbeatTimer: NodeJS.Timeout | null = null;

// 初始化插件管理器
const pluginManager = new PluginManager();

function connect() {
  ws = new WebSocket(SERVER_URL);

  ws.on('open', async () => {
    console.log('Connected to VibeCoding server');
    // 加载所有插件
    await pluginManager.loadAll();

    // 注册Agent
    const registerPayload: AgentRegisterPayload = {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      os: OS,
      arch: ARCH,
      hostname: HOSTNAME,
      supportedFeatures: pluginManager.getSupportedCommands(),
    };
    sendMessage(MessageType.AGENT_REGISTER, registerPayload);

    // 启动心跳，10秒一次
    heartbeatTimer = setInterval(sendHeartbeat, 10000);

    // 支持测试模式：启动时自动运行所有测试用例
    if (process.env.VIBECODING_TEST === 'true') {
      console.log('[test] Running all test cases...');
      const testResult = await pluginManager.runAllTests();
      console.log(`[test] Test result: ${testResult.passed}/${testResult.total} passed`);
      if (testResult.failed > 0) {
        process.exit(1);
      }
      process.exit(0);
    }
  });

  ws.on('message', async (data) => {
    try {
      const message: BaseMessage<ServerRequestPayload> = JSON.parse(data.toString());
      if (message.type === MessageType.SERVER_REQUEST && message.requestId) {
        await handleCommand(message.requestId, message.payload.command, message.payload.params);
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server, reconnecting in 3s...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

async function handleCommand(requestId: string, command: string, params: Record<string, any>) {
  try {
    // 内置命令：运行测试
    if (command === 'internal:run-tests') {
      const result = await pluginManager.runAllTests();
      sendMessage(MessageType.AGENT_RESPONSE, {
        requestId,
        success: true,
        data: result,
      });
      return;
    }

    // 内置命令：获取插件列表
    if (command === 'internal:list-plugins') {
      const plugins = pluginManager.getPlugins().map(p => ({
        name: p.name,
        description: p.description,
        version: p.version,
        supportedCommands: p.supportedCommands,
      }));
      sendMessage(MessageType.AGENT_RESPONSE, {
        requestId,
        success: true,
        data: plugins,
      });
      return;
    }

    // 转发给插件处理
    const result = await pluginManager.executeCommand(command as any, params);
    sendMessage(MessageType.AGENT_RESPONSE, {
      requestId,
      success: true,
      data: result,
    });
  } catch (err) {
    console.error(`Command ${command} failed:`, err);
    sendMessage(MessageType.AGENT_RESPONSE, {
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// 发送心跳
async function sendHeartbeat() {
  try {
    const status = await pluginManager.executeCommand('system:status', {});
    sendMessage(MessageType.AGENT_HEARTBEAT, {
      agentId: AGENT_ID,
      systemLoad: {
        cpu: status.cpu.usage,
        memory: status.memory.usage,
        disk: status.disk[0]?.usage || 0,
      },
    });
  } catch {
    // 忽略心跳错误
  }
}

function sendMessage<T>(type: MessageType, payload: T, requestId?: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const message: BaseMessage<T> = { type, payload, requestId };
  ws.send(JSON.stringify(message));
}

// 启动连接
connect();
