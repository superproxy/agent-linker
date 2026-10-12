import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CodeServerUpstream } from './code-server-upstream.js';
import { toCodeServerProxyPath } from './code-server-upstream.js';

export const VIBE_IDE_PREFIX = '/vibe-ide';

let codeServerTarget: CodeServerUpstream = {
  host: '127.0.0.1',
  port: 8010,
  publicPath: VIBE_IDE_PREFIX,
};

export function setVibeIdeCodeServerTarget(target: CodeServerUpstream): void {
  codeServerTarget = target;
}

export function vibeIdePublicPath(): string {
  return codeServerTarget.publicPath;
}

export function isVibeIdePath(url: string | undefined, publicPath = codeServerTarget.publicPath): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  const prefix = publicPath.replace(/\/+$/, '') || VIBE_IDE_PREFIX;
  return path === prefix || path.startsWith(`${prefix}/`);
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
    host: codeServerTarget.host,
    port: codeServerTarget.port,
    method: req.method ?? 'GET',
    path: toCodeServerProxyPath(req.url, codeServerTarget.publicPath),
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
        host: codeServerTarget.host,
        port: codeServerTarget.port,
        method: request.method,
        path: toCodeServerProxyPath(request.raw.url, codeServerTarget.publicPath),
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
        void reply.code(502).send({
          error: `本机 IDE 未启动，请确认 node serve-web 已监听 ${codeServerTarget.host}:${codeServerTarget.port}`,
        });
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
