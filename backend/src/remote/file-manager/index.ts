import type { FastifyInstance } from 'fastify';
import fs from 'fs-extra';
import { join, resolve, basename, dirname } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export class FileManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir || process.env.HOME || '/');
  }

  registerRoutes(app: FastifyInstance) {
    // 目录列表
    app.get('/api/files/list', async (req, reply) => {
      const { path = '/' } = req.query as { path?: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));
      
      // 防止目录穿越
      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        const stats = await fs.stat(fullPath);
        if (!stats.isDirectory()) {
          return reply.status(400).send({ error: '不是目录' });
        }

        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const entryPath = join(fullPath, entry.name);
          const stat = await fs.stat(entryPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modifiedAt: stat.mtime.getTime(),
            createdAt: stat.birthtime.getTime(),
            path: entryPath.replace(this.baseDir, '').replace(/^\/?/, '/')
          };
        }));

        return {
          currentPath: fullPath.replace(this.baseDir, '').replace(/^\/?/, '/'),
          parentPath: fullPath === this.baseDir ? null : join('/', dirname(fullPath.replace(this.baseDir, ''))),
          files
        };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '读取目录失败' });
      }
    });

    // 读取文件内容
    app.get('/api/files/content', async (req, reply) => {
      const { path } = req.query as { path: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));

      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        const content = await fs.readFile(fullPath, 'utf8');
        return { content };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '读取文件失败' });
      }
    });

    // 写入文件内容
    app.post('/api/files/write', async (req, reply) => {
      const { path, content } = req.body as { path: string; content: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));

      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        await fs.writeFile(fullPath, content, 'utf8');
        return { success: true };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '写入文件失败' });
      }
    });

    // 创建目录
    app.post('/api/files/mkdir', async (req, reply) => {
      const { path } = req.body as { path: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));

      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        await fs.mkdirp(fullPath);
        return { success: true };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '创建目录失败' });
      }
    });

    // 删除文件/目录
    app.delete('/api/files/delete', async (req, reply) => {
      const { path } = req.body as { path: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));

      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        await fs.remove(fullPath);
        return { success: true };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '删除失败' });
      }
    });

    // 重命名/移动
    app.post('/api/files/rename', async (req, reply) => {
      const { oldPath, newPath } = req.body as { oldPath: string; newPath: string };
      const oldFullPath = resolve(this.baseDir, oldPath.replace(/^\//, ''));
      const newFullPath = resolve(this.baseDir, newPath.replace(/^\//, ''));

      if (!oldFullPath.startsWith(this.baseDir) || !newFullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        await fs.rename(oldFullPath, newFullPath);
        return { success: true };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '重命名失败' });
      }
    });

    // 下载文件
    app.get('/api/files/download', async (req, reply) => {
      const { path } = req.query as { path: string };
      const fullPath = resolve(this.baseDir, path.replace(/^\//, ''));

      if (!fullPath.startsWith(this.baseDir)) {
        return reply.status(403).send({ error: '无权限访问该路径' });
      }

      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          return reply.status(400).send({ error: '不能下载目录' });
        }

        reply.header('Content-Disposition', `attachment; filename="${basename(fullPath)}"`);
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(fullPath));
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '下载失败' });
      }
    });
  }
}

export const fileManager = new FileManager();
