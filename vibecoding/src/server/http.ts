import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyProxy from '@fastify/http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve, parse } from 'node:path';
import type { ServerConfig } from './config.js';
import { handleWsMessage } from './wsHandler.js';

export function createHttpServer(config: ServerConfig, wss: WebSocketServer) {
  const app = Fastify({ logger: false });

  // 启用CORS
  app.register(cors, { origin: true });

  // 鉴权中间件
  if (config.auth.token) {
    app.addHook('preHandler', (request, reply, done) => {
      const token = request.headers['authorization']?.replace('Bearer ', '');
      if (!token || token !== config.auth.token) {
        return reply.status(403).send({ error: 'Permission denied' });
      }
      done();
    });
  }

  // ========== 反向代理功能 ==========
  if (config.proxy.enabled) {
    for (const rule of config.proxy.rules) {
      const prefix = rule.match;
      const rewritePrefix = rule.rewrite ? '' : prefix;
      app.register(fastifyProxy, {
        prefix,
        upstream: rule.target,
        rewritePrefix,
        websocket: rule.websocket,
        http2: false,
      });
      console.log(`[proxy] 已添加代理规则: ${prefix} → ${rule.target}`);
    }
  }

  // ========== 服务端本地文件管理API ==========
  if (config.fileManager.enabled) {
    const rootPath = resolve(config.fileManager.rootPath);
    console.log(`[file-manager] 服务端文件管理已启用，根目录: ${rootPath}`);

    // 路径安全校验，防止目录穿越
    function safePath(path: string): string {
      const resolved = join(rootPath, path);
      if (!resolved.startsWith(rootPath)) {
        throw new Error('Path traversal not allowed');
      }
      return resolved;
    }

    // 获取文件列表
    app.get('/api/file/list', async (request, reply) => {
      try {
        const { path = '.' } = request.query as { path?: string };
        const absPath = safePath(path);
        if (!existsSync(absPath)) {
          return reply.status(404).send({ error: 'Path not found' });
        }
        const entries = readdirSync(absPath, { withFileTypes: true });
        const result = entries.map(entry => {
          const entryPath = join(absPath, entry.name);
          const stat = statSync(entryPath);
          return {
            name: entry.name,
            path: entryPath.replace(rootPath, '').replace(/^\/+/, ''),
            isDirectory: entry.isDirectory(),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            mode: stat.mode,
          };
        });
        return { files: result };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // 读取文件内容
    app.get('/api/file/read', async (request, reply) => {
      try {
        const { path, encoding = 'base64' } = request.query as { path: string; encoding?: string };
        const absPath = safePath(path);
        if (!existsSync(absPath) || statSync(absPath).isDirectory()) {
          return reply.status(404).send({ error: 'File not found' });
        }
        const content = readFileSync(absPath);
        const result = encoding === 'base64' ? content.toString('base64') : content.toString(encoding as BufferEncoding);
        return { content, encoding };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // 写入文件
    app.post('/api/file/write', async (request, reply) => {
      if (!config.fileManager.allowWrite) {
        return reply.status(403).send({ error: 'Write operation not allowed' });
      }
      try {
        const { path, content, encoding = 'base64' } = request.body as { path: string; content: string; encoding?: string };
        const absPath = safePath(path);
        const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, encoding as BufferEncoding);
        // 自动创建目录
        const dir = parse(absPath).dir;
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(absPath, buffer);
        return { success: true, path, size: buffer.length };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // 删除文件/目录
    app.post('/api/file/delete', async (request, reply) => {
      if (!config.fileManager.allowDelete) {
        return reply.status(403).send({ error: 'Delete operation not allowed' });
      }
      try {
        const { path } = request.body as { path: string };
        const absPath = safePath(path);
        if (!existsSync(absPath)) {
          return reply.status(404).send({ error: 'Path not found' });
        }
        const stat = statSync(absPath);
        if (stat.isDirectory()) {
          rmSync(absPath, { recursive: true, force: true });
        } else {
          unlinkSync(absPath);
        }
        return { success: true, path };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // 创建目录
    app.post('/api/file/mkdir', async (request, reply) => {
      if (!config.fileManager.allowWrite) {
        return reply.status(403).send({ error: 'Write operation not allowed' });
      }
      try {
        const { path, recursive = true } = request.body as { path: string; recursive?: boolean };
        const absPath = safePath(path);
        mkdirSync(absPath, { recursive });
        return { success: true, path };
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });

    // 预览/下载文件
    app.get('/file/*', async (request, reply) => {
      try {
        const path = (request.params as { '*': string })['*'];
        const absPath = safePath(path);
        if (!existsSync(absPath) || statSync(absPath).isDirectory()) {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.sendFile(absPath);
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    });
  }

  // 挂载WebSocket服务
  app.server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  // 健康检查
  app.get('/healthz', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // 获取Agent拓扑结构
  app.get('/api/topology', async (request, reply) => {
    try {
      const { buildAgentTopology } = await import('./wsHandler.js');
      const topology = buildAgentTopology();
      return { topology };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  return app;
}
