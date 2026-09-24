import type { FastifyInstance } from 'fastify';
import type { AuthGuard } from '../users/auth.js';
import type { ProcessManager } from '../../supervisor/manager.js';
import { getChannelGatewayRuntimeReport } from './runtime-report-store.js';
import { snapshotGatewayDispatchTrace } from '../../store/dispatch-trace.js';

export interface ChannelGatewayLogsApiDeps {
  authGuard: AuthGuard;
  pm: ProcessManager;
}

export type ChannelLogSource = 'auto' | 'pm' | 'push';

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export function registerChannelGatewayLogsApi(app: FastifyInstance, deps: ChannelGatewayLogsApiDeps): void {
  const { authGuard, pm } = deps;

  app.get('/api/channels/channel-gateway/logs', async (request, reply) => {
    if (!authGuard.checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send({ error: '仅管理员可查看 channels 日志' });
    }

    const q = request.query as { tail?: string; source?: string };
    const tail = Math.min(2000, Math.max(20, Number(q.tail) || 300));
    const sourceRaw = typeof q.source === 'string' ? q.source.trim().toLowerCase() : 'auto';
    const source: ChannelLogSource =
      sourceRaw === 'pm' || sourceRaw === 'push' ? sourceRaw : 'auto';

    const report = getChannelGatewayRuntimeReport();
    const pushed = report?.logTail ?? [];
    const pushedSlice = pushed.length > tail ? pushed.slice(pushed.length - tail) : pushed;

    let pmContent = '';
    if (source === 'auto' || source === 'pm') {
      try {
        pmContent = pm.readTailLog('channels', tail);
      } catch {
        pmContent = '';
      }
    }

    let content = '';
    let usedSource: ChannelLogSource = source;
    if (source === 'push') {
      content = joinLines(pushedSlice);
      usedSource = 'push';
    } else if (source === 'pm') {
      content = pmContent;
      usedSource = 'pm';
    } else {
      // auto：本地 pm 日志优先；无文件内容时用推送缓冲（远程/刚启动）
      if (pmContent.trim()) {
        content = pmContent;
        usedSource = 'pm';
      } else if (pushedSlice.length > 0) {
        content = joinLines(pushedSlice);
        usedSource = 'push';
      } else {
        content = pmContent;
        usedSource = 'pm';
      }
    }

    const gatewayTraceLines = snapshotGatewayDispatchTrace(tail);
    const gatewayTrace = joinLines(gatewayTraceLines);

    return {
      id: 'channels',
      tail,
      source: usedSource,
      channelsRunning: pm.isRunning('channels'),
      reportedAt: report?.reportedAt ?? null,
      content,
      gatewayTrace,
      traceHint:
        'channels 日志含 step=channels.*（入站/token/v1/回执）；下方 gateway 追踪含 step=gateway.*（收请求/路由/agent/完成）。同一 traceId 可串起两侧。',
    };
  });
}
