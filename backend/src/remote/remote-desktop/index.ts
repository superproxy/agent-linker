import type { FastifyInstance } from 'fastify';
import { Socket } from 'node:net';

export interface DesktopConfig {
  vncHost: string;
  vncPort: number;
  vncPassword?: string;
  noVncPath: string;
  websockifyPort: number;
}

/**
 * 远程桌面配置与连通性探测。
 * noVNC / websockify 代理尚未挂到网关：缺少 @fastify/http-proxy，且需要管理员鉴权后再开放。
 */
export class RemoteDesktop {
  private config: DesktopConfig = {
    vncHost: '127.0.0.1',
    vncPort: 5900,
    noVncPath: '/usr/share/novnc',
    websockifyPort: 6080,
  };

  registerRoutes(app: FastifyInstance) {
    app.get('/desktop/config', async () => {
      return {
        vncHost: this.config.vncHost,
        vncPort: this.config.vncPort,
        websockifyPort: this.config.websockifyPort,
      };
    });

    app.post('/desktop/config', async (req) => {
      const newConfig = (req.body ?? {}) as Partial<DesktopConfig>;
      this.config = { ...this.config, ...newConfig };
      return { success: true, config: this.config };
    });

    app.get('/desktop/test', async () => {
      const socket = new Socket();
      return new Promise((done) => {
        socket.setTimeout(3000);
        socket.once('connect', () => {
          socket.destroy();
          done({ success: true, message: 'VNC连接正常' });
        });
        socket.once('error', () => {
          done({ success: false, message: '无法连接到VNC服务' });
        });
        socket.once('timeout', () => {
          socket.destroy();
          done({ success: false, message: '连接VNC超时' });
        });
        socket.connect(this.config.vncPort, this.config.vncHost);
      });
    });
  }
}

export const remoteDesktop = new RemoteDesktop();
