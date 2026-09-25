import type { FastifyInstance } from 'fastify';
import { fileManager } from './file-manager/index.js';
import { serviceManager } from './service-manager/index.js';
import { remoteDesktop } from './remote-desktop/index.js';

export async function registerRemoteModule(app: FastifyInstance) {
  // 注册远程管理模块API，统一前缀为/api/remote
  await app.register(async (remoteApp) => {
    // 注册三个子模块
    fileManager.registerRoutes(remoteApp);
    serviceManager.registerRoutes(remoteApp);
    remoteDesktop.registerRoutes(remoteApp);

    // 健康检查
    remoteApp.get('/health', async () => {
      return {
        status: 'ok',
        modules: ['file-manager', 'service-manager', 'remote-desktop']
      };
    });
  }, { prefix: '/api/remote' });

  app.log.info('远程管理模块已注册，API前缀: /api/remote');
}
