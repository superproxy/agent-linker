import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { z } from 'zod';
import { renderFrpcConfig } from './tunnel.js';

const configPath = process.env.NAT_TUNNEL_CONFIG ?? resolve('config/default.yaml');
const file = parse(readFileSync(configPath, 'utf8')) as {
  server?: { host?: string; port?: number };
  frps?: { serverAddr?: string; serverPort?: number; token?: string };
  frpcBin?: string;
  runtimeDir?: string;
};

const host = file.server?.host ?? '127.0.0.1';
const port = file.server?.port ?? 9898;
const serverAddr = file.frps?.serverAddr ?? '127.0.0.1';
const serverPort = file.frps?.serverPort ?? 7000;
const token = file.frps?.token || process.env.NAT_TUNNEL_TOKEN || '';
const frpcBin = process.env.FRPC_BIN || file.frpcBin || 'frpc';
const runtimeDir = resolve(file.runtimeDir ?? '.runtime-state/nat-tunnel');

const bodySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
  localHost: z.string().default('127.0.0.1'),
  localPort: z.number().int().positive().max(65535),
  remotePort: z.number().int(),
});

const children = new Map<string, ChildProcess>();

function stopNamed(name: string): void {
  const child = children.get(name);
  if (!child) return;
  child.kill('SIGTERM');
  children.delete(name);
}

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, tunnels: [...children.keys()] }));

app.post('/api/tunnels', async (req, reply) => {
  const body = bodySchema.parse(req.body);
  const name = body.name ?? `nat-${body.localPort}`;
  if (!token) {
    return reply.code(400).send({ error: '未配置 NAT_TUNNEL_TOKEN' });
  }
  mkdirSync(runtimeDir, { recursive: true });
  const conf = renderFrpcConfig({
    serverAddr,
    serverPort,
    token,
    name,
    localHost: body.localHost,
    localPort: body.localPort,
    remotePort: body.remotePort,
  });
  const confPath = join(runtimeDir, `${name}.toml`);
  writeFileSync(confPath, conf, { encoding: 'utf8', mode: 0o600 });
  stopNamed(name);
  const child = spawn(frpcBin, ['-c', confPath], { windowsHide: true, stdio: 'inherit' });
  child.on('exit', () => {
    if (children.get(name) === child) children.delete(name);
  });
  children.set(name, child);
  return { name, localPort: body.localPort, remotePort: body.remotePort, serverAddr, serverPort };
});

app.delete<{ Params: { name: string } }>('/api/tunnels/:name', async (req, reply) => {
  if (!children.has(req.params.name)) return reply.code(404).send({ error: '隧道不存在' });
  stopNamed(req.params.name);
  return { ok: true };
});

const shutdown = () => {
  for (const name of [...children.keys()]) stopNamed(name);
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host, port });
