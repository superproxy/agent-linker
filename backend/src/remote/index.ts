import { mkdir } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IdeWorkspaceError, registerIdeWorkspace } from './ide-workspace.js';

export interface RemoteModuleOptions {
  /** 默认 IDE 工作区根目录。带 taskId 时改用任务目录 */
  baseDir: string;
  checkAuth: (request: FastifyRequest) => boolean;
  isAdmin: (request: FastifyRequest) => boolean;
  /** 请求带 taskId 时返回该任务目录；未带 taskId 时不会调用 */
  resolveTaskDir?: (request: FastifyRequest) => string | undefined;
}

function taskIdOf(request: FastifyRequest): string {
  const query = request.query as { taskId?: string } | undefined;
  return query?.taskId?.trim() ?? '';
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: { message: '未登录或凭据已失效', code: 'unauthorized' } });
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: { message: '需要管理员权限', code: 'forbidden' } });
}

/**
 * 挂载 /api/remote。
 * 进程管理与远程桌面仍留在各自模块，尚未接入：前者依赖 Linux 命令且允许列表可被前缀绕过，后者依赖尚未安装的代理包。
 */
export async function registerRemoteModule(app: FastifyInstance, options: RemoteModuleOptions): Promise<void> {
  await mkdir(options.baseDir, { recursive: true });
  await app.register(
    async (remoteApp) => {
      remoteApp.addHook('onRequest', async (request, reply) => {
        if (!options.checkAuth(request)) return unauthorized(reply);
        if (taskIdOf(request)) return;
        if (!options.isAdmin(request)) return forbidden(reply);
      });
      registerIdeWorkspace(remoteApp, (request) => {
        const taskId = taskIdOf(request);
        if (!taskId) return options.baseDir;
        const dir = options.resolveTaskDir?.(request);
        if (!dir?.trim()) throw new IdeWorkspaceError('任务不存在', 404, 'not_found');
        return dir;
      });
    },
    { prefix: '/api/remote' },
  );
  app.log.info({ baseDir: options.baseDir }, '在线 IDE 工作区已注册，API 前缀: /api/remote');
}
