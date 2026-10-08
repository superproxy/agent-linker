import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** 本机 code serve-web。须用相同 --server-base-path 启动，资源路径才落在这个前缀下。 */
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 8000;
export const VIBE_IDE_PREFIX = '/vibe-ide';

export function isVibeIdePath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return path === VIBE_IDE_PREFIX || path.startsWith(`${VIBE_IDE_PREFIX}/`);
}

function writeHead(socket: Duplex, statusCode: number, statusMessage: string, headers: IncomingMessage['headers']): void {
  let raw = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) raw += `${key}: ${item}\r\n`;
    } else {
      raw += `${key}: ${value}\r\n`;
    }
  }
  socket.write(`${raw}\r\n`);
}

/** WebSocket 升级原样转到本机 serve-web。 */
export function proxyVibeIdeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const headers = { ...req.headers };
  const proxyReq = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method ?? 'GET',
    path: req.url,
    headers,
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    writeHead(socket, proxyRes.statusCode ?? 101, proxyRes.statusMessage ?? 'Switching Protocols', proxyRes.headers);
    if (proxyHead.length > 0) proxySocket.unshift(proxyHead);
    if (head.length > 0) proxySocket.unshift(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('response', (res) => {
    writeHead(socket, res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway', res.headers);
    res.pipe(socket);
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
}

function proxyVibeIdeHttp(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return new Promise((resolve) => {
    const headers = { ...request.headers };
    const proxyReq = http.request(
      {
        host: TARGET_HOST,
        port: TARGET_PORT,
        method: request.method,
        path: request.raw.url,
        headers,
      },
      (res) => {
        reply.hijack();
        writeHead(reply.raw, res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway', res.headers);
        res.pipe(reply.raw);
        res.on('end', () => resolve());
        res.on('error', () => {
          reply.raw.destroy();
          resolve();
        });
      },
    );
    proxyReq.on('error', () => {
      if (!reply.sent) {
        void reply.code(502).send({ error: '本机 IDE 未启动，请先在 127.0.0.1:8000 运行 code serve-web' });
      }
      resolve();
    });
    request.raw.pipe(proxyReq);
  });
}

/** 在静态资源之前挂上，避免被 prefix / 吃掉。 */
export function registerVibeIdeProxy(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isVibeIdePath(request.raw.url)) return;
    await proxyVibeIdeHttp(request, reply);
  });
}
