/**
 * 插件 HTTP 路由挂载：插件的 handler 是 Node 原生
 * `(req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>` 风格，
 * Fastify 侧直接透传 `request.raw / reply.raw` 并 hijack。
 *
 * 关键点：企业微信回调 Content-Type 为 text/xml / application/xml，Fastify 默认
 * 的 octet-stream 兜底 parser 会把 body 流读走，插件 handler 就收不到密文了。
 * 因此挂载前移除这些默认 parser，让原始流留给插件自行读取。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PluginHttpRouteRegistration } from './api.js';

const RAW_READ_PARSERS = ['text/xml', 'application/xml', 'application/octet-stream'];

export function attachHttpRoutes(app: FastifyInstance, routes: PluginHttpRouteRegistration[]): void {
  for (const name of RAW_READ_PARSERS) {
    try {
      app.removeContentTypeParser(name);
    } catch {
      // 未注册的 parser 忽略
    }
  }
  for (const route of routes) {
    const nodeHandler = route.handler;
    const fastifyHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      reply.hijack();
      try {
        const handled = await nodeHandler(req.raw, reply.raw);
        if (handled === false) {
          reply.raw.statusCode = 404;
          reply.raw.end('not found');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          if (!reply.raw.headersSent) {
            reply.raw.statusCode = 500;
            reply.raw.setHeader('content-type', 'text/plain; charset=utf-8');
            reply.raw.end(`plugin route error: ${message}`);
          } else {
            reply.raw.end();
          }
        } catch {
          // 响应已结束则忽略
        }
        app.log.error({ err, path: route.path }, 'plugin http route failed');
      }
      // hijack 后 Fastify 不再管理响应，返回 reply 表明已被接管
      return reply;
    };
    app.all(route.path, fastifyHandler);
    if (route.match === 'prefix') {
      app.all(`${route.path}/*`, fastifyHandler);
    }
  }
}
