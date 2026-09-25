import type { FastifyInstance } from 'fastify';
import fastifyHttpProxy from '@fastify/http-proxy';
import WebSocket from 'ws';
import { Socket } from 'node:net';

export interface DesktopConfig {
  vncHost: string;
  vncPort: number;
  vncPassword?: string;
  noVncPath: string;
  websockifyPort: number;
}

export class RemoteDesktop {
  private config: DesktopConfig = {
    vncHost: '127.0.0.1',
    vncPort: 5900,
    noVncPath: '/usr/share/novnc',
    websockifyPort: 6080
  };

  registerRoutes(app: FastifyInstance) {
    // 桌面配置接口
    app.get('/api/desktop/config', async (req, reply) => {
      return {
        vncHost: this.config.vncHost,
        vncPort: this.config.vncPort,
        websockifyPort: this.config.websockifyPort
      };
    });

    app.post('/api/desktop/config', async (req, reply) => {
      const newConfig = req.body as Partial<DesktopConfig>;
      this.config = { ...this.config, ...newConfig };
      return { success: true, config: this.config };
    });

    // 测试VNC连接
    app.get('/api/desktop/test', async (req, reply) => {
      const socket = new Socket();
      return new Promise((resolve) => {
        socket.setTimeout(3000);
        socket.once('connect', () => {
          socket.destroy();
          resolve({ success: true, message: 'VNC连接正常' });
        });
        socket.once('error', () => {
          resolve({ success: false, message: '无法连接到VNC服务' });
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve({ success: false, message: '连接VNC超时' });
        });
        socket.connect(this.config.vncPort, this.config.vncHost);
      });
    });

    // 代理noVNC静态资源
    app.register(fastifyHttpProxy, {
      prefix: '/desktop',
      upstream: `http://127.0.0.1:${this.config.websockifyPort}`,
      rewritePrefix: '',
      websocket: true
    });

    // WebSocket VNC代理
    app.get('/ws/desktop', { websocket: true }, (socket, req) => {
      // 连接到VNC服务
      const vncSocket = new WebSocket(`ws://127.0.0.1:${this.config.websockifyPort}/websockify`);
      
      vncSocket.on('open', () => {
        // 双向转发消息
        socket.on('message', (data: Buffer) => {
          vncSocket.send(data);
        });

        vncSocket.on('message', (data: Buffer) => {
          socket.send(data);
        });
      });

      // 错误和关闭处理
      vncSocket.on('error', (err) => {
        socket.close(1011, `VNC连接错误: ${err.message}`);
      });

      vncSocket.on('close', () => {
        socket.close(1000, 'VNC连接关闭');
      });

      socket.on('close', () => {
        vncSocket.close();
      });
    });
  }

  /**
   * 安装依赖命令：
   * apt install -y novnc websockify tigervnc-standalone-server
   * 启动websockify: websockify 6080 127.0.0.1:5900
   * 启动VNC服务: vncserver :0 -geometry 1920x1080 -depth 24
   */
}

export const remoteDesktop = new RemoteDesktop();
