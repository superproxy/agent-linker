import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import yaml from 'yaml';
import { PortProxyService } from './port-proxy.js';

// 加载配置
const config = yaml.parse(readFileSync(join(__dirname, '../config/default.yaml'), 'utf8'));

const fastify = Fastify({ logger: true });

// 启用CORS
fastify.register(cors, { origin: true });

// API接口定义
const createProxySchema = z.object({
  agentId: z.string(),
  localPort: z.number().int().min(1).max(65535),
  proxyType: z.enum(['nginx', 'frp']).default('nginx'),
  domain: z.string().optional(),
  subdomain: z.string().optional(),
});

const stopProxySchema = z.object({
  proxyId: z.string(),
  proxyType: z.enum(['nginx', 'frp']),
});

// 创建代理
fastify.post('/api/proxy/create', async (request, reply) => {
  try {
    const body = createProxySchema.parse(request.body);
    // 模拟Agent信息
    const agent = { agentId: body.agentId, os: 'linux', arch: 'x64', online: true } as any;
    const result = await PortProxyService.createProxy(body.agentId, body.localPort, body.proxyType, {
      domain: body.domain,
      subdomain: body.subdomain,
    });
    return { success: true, data: result };
  } catch (err) {
    return reply.status(400).send({ success: false, error: (err as Error).message });
  }
});

// 停止代理
fastify.post('/api/proxy/stop', async (request, reply) => {
  try {
    const body = stopProxySchema.parse(request.body);
    await PortProxyService.stopProxy(body.proxyId, body.proxyType);
    return { success: true };
  } catch (err) {
    return reply.status(400).send({ success: false, error: (err as Error).message });
  }
});

// 健康检查
fastify.get('/healthz', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

// 启动服务
const start = async () => {
  try {
    await fastify.listen({ port: config.server.port, host: config.server.host });
    console.log(`🚀 端口代理服务已启动，监听地址: http://${config.server.host}:${config.server.port}`);
    console.log(`📦 支持代理类型: ${config.nginx.enabled ? 'nginx' : ''} ${config.frp.enabled ? 'frp' : ''}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
