import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { isNodeTokenShape, type NodeTokenStore } from '../users/node-token-store.js';

/** 与 frp 0.60 util.GetAuthKey 相同：md5(token + 十进制时间戳) 的十六进制。 */
export function frpPrivilegeKey(token: string, timestamp: number): string {
  return createHash('md5').update(token).update(String(timestamp)).digest('hex');
}

function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type FrpLoginDecision =
  | { action: 'allow' }
  | { action: 'rewrite'; privilegeKey: string }
  | { action: 'reject' };

/**
 * frps 内置校验只认一个 auth.token。
 * 已是这份 token 则原样通过；对上任一 nt_ 则把 privilege_key 改写成内部 token，再交给 frps。
 */
export function resolveFrpLogin(input: {
  privilegeKey: string;
  timestamp: number;
  serverToken: string;
  nodeTokens: readonly string[];
}): FrpLoginDecision {
  const presented = input.privilegeKey.trim();
  const serverToken = input.serverToken.trim();
  if (!presented || !serverToken || !Number.isInteger(input.timestamp)) return { action: 'reject' };
  const serverKey = frpPrivilegeKey(serverToken, input.timestamp);
  if (sameKey(presented, serverKey)) return { action: 'allow' };
  for (const token of input.nodeTokens) {
    if (!isNodeTokenShape(token)) continue;
    if (sameKey(presented, frpPrivilegeKey(token, input.timestamp))) {
      return { action: 'rewrite', privilegeKey: serverKey };
    }
  }
  return { action: 'reject' };
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** frps 本机插件。只接受回环，不把 nt_ 明文写进响应。 */
export function registerFrpPluginRoute(app: FastifyInstance, opts: {
  nodeTokenStore: NodeTokenStore;
  frpsTokenFile: string;
}): void {
  app.post('/internal/frp/handler', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ reject: true, reject_reason: 'forbidden' });
    }
    const body = request.body as { op?: string; content?: Record<string, unknown> } | undefined;
    const content = body?.content;
    if (body?.op !== 'Login' || !content || typeof content !== 'object') {
      return { reject: false, unchange: true };
    }
    const serverToken = existsSync(opts.frpsTokenFile) ? readFileSync(opts.frpsTokenFile, 'utf8').trim() : '';
    const decision = resolveFrpLogin({
      privilegeKey: String(content.privilege_key ?? ''),
      timestamp: Number(content.timestamp),
      serverToken,
      nodeTokens: opts.nodeTokenStore.listTokens(),
    });
    if (decision.action === 'reject') {
      return { reject: true, reject_reason: 'token 无效' };
    }
    if (decision.action === 'allow') return { reject: false, unchange: true };
    return {
      reject: false,
      unchange: false,
      content: { ...content, privilege_key: decision.privilegeKey },
    };
  });
}
