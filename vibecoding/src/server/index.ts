import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { handleWsMessage, handleWsDisconnect } from './wsHandler.js';

const config = loadConfig();
const PORT = config.server.port;
const HOST = config.server.host;

// 创建WebSocket服务
const wss = new WebSocketServer({ noServer: true });
console.log(`VibeCoding WebSocket server running at ws://${HOST}:${PORT}/ws`);

// WebSocket连接处理
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleWsMessage(ws, message);
    } catch (err) {
      console.error('Message parse error:', err);
      sendMessage(ws, 'server:error', {
        code: 400,
        message: 'Invalid message format',
      });
    }
  });

  ws.on('close', () => {
    handleWsDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// 创建HTTP服务
const app = createHttpServer(config, wss);

// 启动服务
async function start() {
  if (config.server.enableHttp) {
    await app.listen({ port: PORT, host: HOST });
    console.log(`VibeCoding HTTP server running at http://${HOST}:${PORT}`);
    if (config.proxy.enabled) {
      console.log(`[proxy] 反向代理已启用，规则数: ${config.proxy.rules.length}`);
    }
    if (config.fileManager.enabled) {
      console.log(`[file-manager] 服务端文件管理已启用，API前缀: /api/file`);
    }
  }
}

start().catch(err => {
  console.error('Server start failed:', err);
  process.exit(1);
});

function sendMessage<T>(ws: any, type: string, payload: T, requestId?: string) {
  if (ws.readyState !== 1) return;
  const message = { type, payload, requestId };
  ws.send(JSON.stringify(message));
}
