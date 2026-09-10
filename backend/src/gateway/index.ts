import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { loadGatewayConfig, findRepoRoot } from './config.js';
import { AgentManager, type AgentPatch } from './agents/manager.js';
import { collectModelCandidates } from './modelcandidates.js';
import { PluginManager } from './plugins/manager.js';
import { createJsonStore } from './tasks/store.js';
import { TaskService } from './tasks/service.js';
import { decideTaskRouting, registerTaskApi } from './tasks/api.js';
import { startWeixinBot, type WeixinBotHandle } from '../channels/weixin-bot.js';
import {
  formatSseData,
  SSE_DONE,
  modelIdFor,
  messagesToText,
  defaultAgentDefinitions,
  type AgentDefinition,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
} from '@linkagent/shared';

/** 内置控制台页（单文件，打开 GET / 即可切换 agent/模型并对话测试） */
const CONSOLE_PAGE = readFileSync(new URL('../dev/console.html', import.meta.url), 'utf8');

/** 请求体扩展：linkagent 任务路由字段（OpenAI 兼容字段保持原样，多出的字段透明透传） */
type TaskAwareChatBody = ChatCompletionRequest & {
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  sessionKey?: string;
};

/**
 * OpenAI 兼容网关 HTTP 入口（Chatbox / Open WebUI → /v1 → ACP(acpx) → agent）。
 * 路由：
 *   GET  /v1/models             列出 agent:opencode / agent:pi 等模型
 *   POST /v1/chat/completions   支持 stream / 非 stream（SSE）；渠道请求可带 channel/userId/agent/task（任务路由）
 * 配置见 backend/config/gateway.yaml（缺省 127.0.0.1:8787，agent 用内置默认）。
 */

interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

function openaiError(message: string, type: string, code: string | null): OpenAiErrorBody {
  return { error: { message, type, param: null, code } };
}

/** 每请求的 SSE 元数据 */
function newMeta(model: string) {
  return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model };
}

function chunkDelta(
  meta: ReturnType<typeof newMeta>,
  delta: { role?: string; content?: string; reasoning_content?: string },
  finish: ChatCompletionChunk['choices'][number]['finish_reason'],
): ChatCompletionChunk {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export async function buildServer(options?: { configPath?: string; definitions?: AgentDefinition[] }): Promise<{
  app: FastifyInstance;
  manager: AgentManager;
  pluginManager: PluginManager | null;
  /** 任务公共能力（多渠道共享，/v1 命令/路由 + /api/tasks 管理） */
  taskService: TaskService;
  /** 个人微信渠道实现句柄（weixin.mode=weixin-bot 时非空，server listen 后由 main 调 start） */
  weixinBot: { start(): Promise<void>; stop(): Promise<void> } | null;
  host: string;
  port: number;
  authEnabled: boolean;
}> {
  const { config } = loadGatewayConfig(options?.configPath);
  const definitions = options?.definitions ?? (config.agents.length > 0 ? config.agents : defaultAgentDefinitions());
  const manager = new AgentManager({ definitions });
  await manager.start();

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(cors, { origin: true });

  const checkAuth = (request: FastifyRequest): boolean => {
    if (!config.auth.enabled) return true;
    const h = request.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
    return config.auth.token !== '' && token === config.auth.token;
  };

  // ── 任务公共能力（多渠道共享；state 落在 <repo>/.runtime-state/tasks/）──
  const taskStateDir = join(findRepoRoot(), '.runtime-state', 'tasks');
  const taskService = new TaskService({
    store: createJsonStore(taskStateDir),
    defaultAgentId: config.tasks?.defaultAgentId,
  });
  registerTaskApi(app, taskService, (req) => checkAuth(req as FastifyRequest));

  app.get('/healthz', async () => ({ ok: true, agents: manager.listDescriptors() }));

  app.get('/v1/models', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    const data = manager.listDescriptors().map((d) => ({
      id: modelIdFor(d.id),
      object: 'model',
      created: 0,
      owned_by: 'linkagent',
      description: d.description,
    }));
    return { object: 'list', data };
  });

  app.post('/v1/chat/completions', async (request: FastifyRequest<{ Body: TaskAwareChatBody }>, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }

    const body = request.body;
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return reply.code(400).send(openaiError('请求体需含 model(string) 与 messages(array)', 'invalid_request_error', 'invalid_request'));
    }

    // oneshot 无状态会话：把客户端全量多轮历史拼成一段完整上下文一次性下发。
    // 渠道 adapter（botAgent）可传 sessionKey 扩展字段 → 复用同一 agent 持久会话（有记忆）。
    const prompt = messagesToText(body.messages);
    if (!prompt) {
      return reply.code(400).send(openaiError('messages 中没有可发送的文本', 'invalid_request_error', 'empty_messages'));
    }

    // ── 任务路由（渠道传 channel/userId/agent/task）──
    // 命令 → 本地解析回文本（不走 agent）；普通消息 → 激活任务派生 agentId+sessionKey；
    // 无 channel/userId → 原 model+sessionKey 路径（兼容）。
    // 注意：命令判断用最后一条用户消息的原始文本（messagesToText 会加 "User: " 前缀，命令识别需原文）
    const lastUserText =
      body.messages
        .filter((m): m is { role: 'user'; content: string } => m.role === 'user' && typeof m.content === 'string')
        .at(-1)?.content ?? '';
    const routing = decideTaskRouting(taskService, {
      channel: body.channel,
      userId: body.userId,
      agent: body.agent,
      task: body.task,
      text: lastUserText || prompt,
    });
    if (routing.kind === 'command') {
      if (body.stream !== true) {
        const result: ChatCompletion = {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: routing.text }, finish_reason: 'stop' }],
        };
        return result;
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const meta = newMeta(body.model);
      res.write(formatSseData(chunkDelta(meta, { role: 'assistant', content: routing.text }, 'stop')));
      res.write(SSE_DONE);
      res.end();
      return;
    }

    const modelForChat = routing.kind === 'chat' ? modelIdFor(routing.agentId) : body.model;
    const sessionKeyForChat = routing.kind === 'chat'
      ? routing.sessionKey
      : (typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '');

    const adapter = manager.resolve(modelForChat);
    if (!adapter) {
      const known = manager.listDescriptors().map((d) => modelIdFor(d.id)).join(', ');
      return reply
        .code(404)
        .send(openaiError(`未知模型 "${modelForChat}"；可用: ${known}`, 'invalid_request_error', 'model_not_found'));
    }

    const chatRequest = {
      messages: [{ role: 'user' as const, content: prompt }],
      ...(sessionKeyForChat ? { sessionKey: sessionKeyForChat } : {}),
    };
    const meta = newMeta(modelForChat);

    // ---- 非流式：聚合后一次返回 ----
    if (body.stream !== true) {
      let content = '';
      try {
        await adapter.chat(chatRequest, {
          onText: (d) => {
            content += d;
          },
          onReasoning: () => {},
          onToolActivity: (name) => request.log.info({ tool: name }, 'tool activity'),
          onSessionId: (id) => request.log.debug({ sessionId: id }, 'acp session'),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'agent chat failed');
        return reply.code(500).send(openaiError(message, 'server_error', 'agent_error'));
      }
      const result: ChatCompletion = {
        id: meta.id,
        object: 'chat.completion',
        created: meta.created,
        model: modelForChat,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      };
      return result;
    }

    // ---- 流式：SSE chat.completion.chunk ----
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    res.on('close', onAbort);

    const send = (chunk: ChatCompletionChunk) => res.write(formatSseData(chunk));

    try {
      send(chunkDelta(meta, { role: 'assistant', content: '' }, null));
      await adapter.chat(
        chatRequest,
        {
          onText: (d) => send(chunkDelta(meta, { content: d }, null)),
          onReasoning: (d) => send(chunkDelta(meta, { reasoning_content: d }, null)),
          onToolActivity: (name) => request.log.info({ tool: name }, 'tool activity'),
          onSessionId: (id) => request.log.debug({ sessionId: id }, 'acp session'),
        },
        controller.signal,
      );
      send(chunkDelta(meta, {}, 'stop'));
      res.write(SSE_DONE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, 'agent chat failed (stream)');
      // 流已开启，无法改状态码：以 SSE error 事件结束
      res.write(formatSseData(openaiError(message, 'server_error', 'agent_error')));
      res.write(SSE_DONE);
    } finally {
      res.removeListener('close', onAbort);
      res.end();
    }
  });

  // ── 控制台与运行态控制 API（GET / 打开单页；/api/agents 供切换 agent/模型）──
  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(CONSOLE_PAGE);
  });

  app.get('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    return { agents: manager.listAgentDetails() };
  });

  app.get('/api/agents/candidates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    const candidates: Record<string, string[]> = {};
    for (const d of manager.listAgentDetails()) candidates[d.id] = collectModelCandidates(d.type);
    return { candidates };
  });

  app.patch('/api/agents/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    const body = request.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send(openaiError('请求体需为 JSON 对象', 'invalid_request_error', 'invalid_request'));
    }
    const patch: AgentPatch = {};
    if ('model' in body) {
      const m = body.model;
      if (m === null || m === undefined) patch.model = null;
      else if (typeof m === 'string') patch.model = m;
      else return reply.code(400).send(openaiError('model 需为字符串或 null', 'invalid_request_error', 'invalid_request'));
    }
    if ('enabled' in body) {
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      else return reply.code(400).send(openaiError('enabled 需为布尔值', 'invalid_request_error', 'invalid_request'));
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send(openaiError('请求体需含 model 或 enabled', 'invalid_request_error', 'invalid_request'));
    }
    try {
      const agent = manager.updateAgent(request.params.id, patch);
      return { agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(404).send(openaiError(message, 'invalid_request_error', 'agent_not_found'));
    }
  });

  // ── 个人微信渠道实现二选一 ──
  //  mode=openclaw-weixin-plugin：加载 openclaw-weixin 插件运行时（登录态复用 accounts/）
  //  mode=weixin-bot（默认）：跳过该插件，改由网关进程内拉起独立 adapter（少跑一套插件运行时）
  const weixinMode = config.weixin?.mode ?? 'weixin-bot';
  const skipWeixinPlugin = weixinMode === 'weixin-bot';
  const plugins = (config.plugins ?? []).filter(
    (p) => !(skipWeixinPlugin && p.package === '@tencent-weixin/openclaw-weixin'),
  );
  const effectiveConfig = { ...config, plugins };

  // ── openclaw 插件运行时（企业微信 / 个人微信渠道）──
  // 配置了 channels.<id> 或 plugins[] 时加载插件包；插件缺失 / 加载失败仅告警，不影响 /v1
  let pluginManager: PluginManager | null = null;
  if (Object.keys(config.channels).length > 0 || plugins.length > 0) {
    const stateDir = join(findRepoRoot(), '.runtime-state', 'plugins');
    // 微信插件读 OPENCLAW_STATE_DIR 定位 accounts.json / openclaw.json
    process.env.OPENCLAW_STATE_DIR = stateDir;
    pluginManager = new PluginManager({
      manager,
      config: effectiveConfig as unknown as Record<string, unknown>,
      stateDir,
      logger: app.log as never,
    });
    try {
      await pluginManager.start(app);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err }, `插件运行时启动失败（/v1 不受影响）：${message}`);
      await pluginManager.dispose().catch(() => {});
      pluginManager = null;
    }
  } else if (skipWeixinPlugin) {
    app.log.info('未配置 channels/plugins（个人微信走 weixin-bot 独立 adapter），跳过插件运行时');
  } else {
    app.log.info('未配置 channels/plugins，跳过插件运行时（渠道未启用）');
  }

  // weixin-bot 句柄：server listen 后由 main 启动（长轮询 monitor 需网关 /v1 已就绪）
  let weixinBotHandle: WeixinBotHandle | null = null;
  const weixinBot = skipWeixinPlugin
    ? {
        async start(): Promise<void> {
          weixinBotHandle = await startWeixinBot({
            gatewayUrl: `http://127.0.0.1:${config.server.port}`,
            model: config.weixin?.model,
            accountId: config.weixin?.accountId,
            log: (...args: unknown[]) => app.log.info(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
            errLog: (...args: unknown[]) => app.log.error(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
          });
          app.log.info({ account: weixinBotHandle.account.id }, '[weixin-bot] 个人微信渠道已启动（独立 adapter 模式）');
        },
        async stop(): Promise<void> {
          await weixinBotHandle?.stop().catch(() => {});
          weixinBotHandle = null;
        },
      }
    : null;

  return { app, manager, pluginManager, taskService, weixinBot, host: config.server.host, port: config.server.port, authEnabled: config.auth.enabled };
}

async function main(): Promise<void> {
  const { app, manager, pluginManager, weixinBot, host, port, authEnabled } = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await weixinBot?.stop().catch(() => {});
    await pluginManager?.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host, port });
  // weixin-bot 模式：listen 后再拉起长轮询 monitor（需网关 /v1 已就绪）
  if (weixinBot) {
    await weixinBot.start().catch((err: unknown) => {
      app.log.error({ err }, 'weixin-bot 启动失败（/v1 不受影响）；请先扫码登录：pnpm --filter @linkagent/backend weixin-login');
    });
  }
  app.log.info(
    { baseUrl: `http://${host}:${port}/v1`, authEnabled },
    'OpenAI 兼容网关就绪：Chatbox/Open WebUI 配置 base_url=http://${host}:${port}/v1',
  );
}

// 直接运行入口（tsx src/index.ts）；被测试 import 时只导出 buildServer
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((err) => {
    console.error('gateway 启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
