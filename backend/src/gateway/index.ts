import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { loadSharedConfig, persistDefaultTaskAgentId, persistAgentEnabled, persistNodeAgentRegistered, persistEnsureWeixinAccount, persistRemoveWeixinAccount, resolveGatewayAuth, deriveGatewayBase } from './config.js';
import type { SharedConfig } from '@linkagent/shared';
import { createInstallLayout, getLayout } from '../install/layout.js';
import { AgentManager, type AgentPatch } from './agents/manager.js';
import { AGENT_CATALOG, enrichAgentInfos, type AcpAgentKind } from './agents/acpWrapper.js';
import { AgentInstallError, runAgentInstall } from './agents/installCli.js';
import { collectModelCandidates } from './modelcandidates.js';
import { PluginManager } from './plugins/manager.js';
import { createJsonStore } from './tasks/store.js';
import { TaskService } from './tasks/service.js';
import { readTaskSkillMarkdown } from './tasks/skill-files.js';
import { decideTaskRouting, registerTaskApi } from './tasks/api.js';
import { NodeManager } from './nodes/manager.js';
import { createNodeRegistry } from './nodes/store.js';
import { createPreferenceStore } from './prefs/store.js';
import { registerNodeApi } from './nodes/api.js';
import { canSeeNode } from './nodes/visibility.js';
import { ProcessManager, type ProcessInstanceId } from '../supervisor/manager.js';
import { registerPmApi } from './pm/api.js';
import { UserStore } from './users/store.js';
import { AuthGuard } from './users/auth.js';
import { ChannelTokenStore } from './users/channel-token-store.js';
import { PersonalTokenStore } from './users/personal-token-store.js';
import { NodeTokenStore } from './users/node-token-store.js';
import { NodeClaimStore } from './users/node-claim-store.js';
import { registerAuthApi, registerUserApi } from './users/api.js';
import { registerChannelTokenApi } from './users/channel-token-api.js';
import { registerPersonalTokenApi } from './users/personal-token-api.js';
import { registerNodeTokenApi } from './users/node-token-api.js';
import { registerNodeClaimApi } from './users/node-claim-api.js';
import { startWeixinBot, type WeixinBotHandle } from '../channels/weixin-bot.js';
import { InProcessUserTokenProvider } from '../channels/user-token.js';
import { registerWeixinApi, WeixinLoginService } from './weixin-login.js';
import {
  formatSseData,
  SSE_DONE,
  ACP_AGENT_KINDS,
  modelIdFor,
  messagesToText,
  defaultAgentDefinitions,
  LOCAL_NODE_ID,
  LOCAL_NODE_NAME,
  type AgentDefinition,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
} from '@linkagent/shared';



/** 请求体扩展：linkagent 任务路由字段（OpenAI 兼容字段保持原样，多出的字段透明透传） */
type TaskAwareChatBody = ChatCompletionRequest & {
  channel?: string;
  userId?: string;
  agent?: string;
  task?: string;
  /** 登录用户任务空间（微信 bot 账号槽 = 用户名） */
  ownerUsername?: string;
  /** 任务全局 key：单 key 直连路由（无需 channel/userId/task 三元素） */
  taskKey?: string;
  sessionKey?: string;
};

/**
 * OpenAI 兼容网关 HTTP 入口（Chatbox / Open WebUI → /v1 → ACP(acpx) → agent）。
 * 路由：
 *   GET  /v1/models             列出 agent:opencode / agent:pi 等模型
 *   POST /v1/chat/completions   支持 stream / 非 stream（SSE）；渠道请求可带 channel/userId/agent/task（任务路由）
 * 配置见 backend/config/config.yaml（缺省 127.0.0.1:8787，agent 用内置默认）。
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

export async function buildServer(options?: {
  configPath?: string;
  definitions?: AgentDefinition[];
  /** 隔离运行态根目录：所有 .runtime-state 子目录（tasks/users/nodes/prefs...）都写到这里。集成测试用，避免污染真实状态。 */
  stateRoot?: string;
}): Promise<{
  app: FastifyInstance;
  manager: AgentManager;
  pluginManager: PluginManager | null;
  /** 任务公共能力（多渠道共享，/v1 命令/路由 + /api/tasks 管理） */
  taskService: TaskService;
  /** 远程节点管理（WebSocket 连接、心跳、turn 多路复用） */
  nodeManager: NodeManager;
  /** 个人微信渠道实现句柄（weixin.mode=weixin-bot 时非空，server listen 后由 main 调 start） */
  weixinBot: { start(): Promise<void>; stop(): Promise<void>; reload(): Promise<void> } | null;
  host: string;
  port: number;
  authEnabled: boolean;
}> {
  const layout = options?.stateRoot ? createInstallLayout(options.stateRoot) : getLayout();
  const runtimeGatewayDir = layout.state('gateway');
  const { config: sharedConfig, path: configPath } = loadSharedConfig(
    options?.configPath,
    runtimeGatewayDir,
  );
  const config: SharedConfig = sharedConfig;
  // 便捷别名：gateway 段（原扁平配置整体收敛于此）
  const gw = config.gateway;
  // 进程管理器托管微信时注入 LINKAGENT_WEIXIN_MODE=external：gateway 不内嵌 bot，改由独立进程运行。
  // 注意：zod default() 产出的对象嵌套属性是只读代理，直接赋 config.weixin.mode 会被静默忽略，必须整体替换。
  const envWeixinMode = process.env.LINKAGENT_WEIXIN_MODE;
  if (envWeixinMode === 'external' || envWeixinMode === 'weixin-bot' || envWeixinMode === 'openclaw-weixin-plugin') {
    config.weixin = { ...config.weixin, mode: envWeixinMode };
  }
  const definitions = options?.definitions ?? (gw.agents.length > 0 ? gw.agents : defaultAgentDefinitions());

  // 安装布局：形态判定（dev/dist）与所有运行态路径的唯一来源
  // 测试可传 stateRoot 把运行态指到临时根（createInstallLayout 可传任意 root），避免集成测试污染真实 .runtime-state
  // ── 鉴权：local/token/open；gateway token 配置优先，空则自动生成落盘（三进程共享）──
  const auth = resolveGatewayAuth(config, layout.gatewayTokenFile);
  const authEnabled = auth.mode !== 'open';

  // ── 远程节点：注册表落 .runtime-state/nodes，WebSocket 服务在 app.listen 后挂到同一 http server ──
  const nodeRegistry = createNodeRegistry(layout.nodesState);
  const nodeTokenStore = new NodeTokenStore(layout.usersState);
  const nodeClaimStore = new NodeClaimStore(layout.usersState);
  const nodeManager = new NodeManager({
    registry: nodeRegistry,
    // local/token：网关 token 或用户颁发的 nt_ 均可直连；open 不校验
    expectedToken: authEnabled ? auth.token : '',
    resolveNodeToken: (token) => {
      const rec = nodeTokenStore.resolve(token);
      if (!rec) return null;
      nodeTokenStore.touch(token);
      return { username: rec.username, ...(rec.nodeId ? { nodeId: rec.nodeId } : {}) };
    },
    bindNodeToken: (token, nodeId) => nodeTokenStore.bindNode(token, nodeId),
    resolveNodeClaim: (claimToken) => {
      const rec = nodeClaimStore.resolve(claimToken);
      if (!rec) return null;
      nodeClaimStore.touch(claimToken);
      return rec.username;
    },
    logger: {
      info: (m) => console.log(`[nodes] ${m}`),
      warn: (m) => console.warn(`[nodes] ${m}`),
      error: (m) => console.error(`[nodes] ${m}`),
    },
  });

  const manager = new AgentManager({ definitions, defaultCwd: gw.defaultCwd, nodeManager });
  await manager.start();

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(cors, { origin: true });
  // Fastify 5：Content-Type 为 json 且 body 为空会 400。后台若干 POST（批准节点等）无 body。
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body : '';
    if (!raw.trim()) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ── web 管理端静态资源（只在网关 8787 单端口提供，不再有独立 vite dev server）──
  // 布局层按形态探测：dist→<root>/web，dev→web/dist（index.html + assets 同时存在才算产物）。
  const webRoot = layout.webRoot;
  if (!webRoot) {
    app.log.info('未找到 web 构建产物（web/dist），跳过 web 挂载；可执行 pnpm build:web 生成');
  }

  // ── 用户登录体系：账号密码 + 会话 token（与 gateway token 并存）──
  const userStore = new UserStore(layout.usersState);
  // local 模式按运行模式免登录，不预创建 admin；token 模式在首次需要登录的 /api/auth/me 时再生成随机密码。
  // 渠道终端用户级凭据（微信 bot 代用户直连网关）：.runtime-state/users/channel-tokens/
  const channelTokenStore = new ChannelTokenStore(layout.usersState);
  // 登录账号个人 API token（用户自助，OpenAI 客户端直连 /v1）：.runtime-state/users/personal-tokens/
  const personalTokenStore = new PersonalTokenStore(layout.usersState);

  // ── 任务公共能力（多渠道共享；state 落在 .runtime-state/tasks/）──
  // 先于 AuthGuard 创建：任务 key 直连鉴权需用 taskService 反查 key → 任务
  const taskStateDir = layout.tasksState;
  const skillMarkdown = readTaskSkillMarkdown(layout.root);
  const taskService = new TaskService({
    store: createJsonStore(taskStateDir),
    defaultAgentId: gw.tasks?.defaultAgentId,
    // 任务工作空间隔离：每个任务默认独立目录 <root>/<登录用户名>/<taskId>，可经 gateway.tasks.workspaceDir 配置
    workspaceRoot: gw.tasks?.workspaceDir ?? layout.tasksWorkspace,
    ...(skillMarkdown
      ? {
          skill: {
            markdown: skillMarkdown,
            baseUrl: deriveGatewayBase(config),
            personalTokenFor: (username) => personalTokenStore.ensure(username).token,
          },
        }
      : {}),
  });

  const authGuard = new AuthGuard(userStore, {
    mode: auth.mode,
    staticToken: auth.token,
    sessionTtlDays: auth.sessionTtlDays,
    // 任务 key 直连：/v1 接受 Bearer <taskKey> 或 body.taskKey 作为任务级凭据
    taskKeys: taskService,
    // 用户级凭据：微信 bot 按渠道用户携带 ct_ token
    channelTokens: channelTokenStore,
    // 登录账号个人 API token：pat_ 凭据，等同账号本人
    personalTokens: personalTokenStore,
  });
  registerAuthApi(app, userStore, authGuard);
  const pm = new ProcessManager(layout.root, {
    extraWeixinAccounts: () => config.weixin.accounts ?? [],
  });
  registerUserApi(app, userStore, authGuard, personalTokenStore, nodeTokenStore, nodeClaimStore, async (username) => {
    taskService.deleteOwnedBy(username);
    try {
      const next = persistRemoveWeixinAccount(configPath, username, runtimeGatewayDir);
      config.weixin = { ...config.weixin, accounts: next };
      await pm.stop([`weixin:${username}` as ProcessInstanceId]);
    } catch {
      /* 删用户时停微信进程失败不阻断 */
    }
  });
  registerChannelTokenApi(app, channelTokenStore, authGuard, taskService, {
    listAvailableAgents: () => manager.listAgentDetails().map((a) => a.id),
  });
  registerPersonalTokenApi(app, personalTokenStore, authGuard);
  registerNodeTokenApi(app, nodeTokenStore, authGuard);
  registerNodeClaimApi(app, nodeClaimStore, authGuard);

  const checkAuth = (request: FastifyRequest): boolean => authGuard.checkAuth(request);

  registerTaskApi(
    app,
    taskService,
    (req) => checkAuth(req as FastifyRequest),
    {
      // 可选范围与管理后台 Agent 下拉一致（已定义的 agent，含临时停用的，便于先设默认后启用）
      listAvailableAgents: () => manager.listAgentDetails().map((a) => a.id),
      // 建/改任务时校验 (节点, agent) 组合当前可路由
      hasRoutingAgent: (nodeId, agentId) => manager.hasRoutingAgent(nodeId, agentId),
      // 原子化运行时：先改内存再落盘 config.yaml；落盘抛错时接口层回滚内存值
      persistDefaultAgent: (agentId) => {
        persistDefaultTaskAgentId(configPath, agentId, runtimeGatewayDir);
        // zod default 产出只读代理：整体替换 gateway 段
        config.gateway = { ...config.gateway, tasks: { ...config.gateway.tasks, defaultAgentId: agentId } };
      },
      isAdmin: (req) => authGuard.isAdmin(req as FastifyRequest),
      sessionUser: (req) => {
        const u = authGuard.sessionUser(req as FastifyRequest);
        return u ? { username: u.username } : null;
      },
      skillAuth: (req) => {
        const s = authGuard.resolve(req as FastifyRequest);
        if (s.status === 'personal' || s.status === 'session' || s.status === 'channelUser') return 'ok';
        if (s.status === 'none') return 'unauth';
        return 'forbidden';
      },
    },
    // 渠道用户级凭据：ct_ token 只读自己的 GET /api/tasks（微信 bot 查激活任务用）
    (req) => {
      const s = authGuard.resolve(req as FastifyRequest);
      return s.status === 'channelUser' ? { channel: s.channel, userId: s.userId } : null;
    },
  );

  // 删除渠道用户时级联吊销其用户级 token（覆盖 tasks api 内同名路由，先注册者优先）
  app.delete('/api/users/:channel/:userId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!authGuard.isAdmin(request)) return reply.code(403).send({ error: 'forbidden' });
    const params = request.params as { channel: string; userId: string };
    const owner = (request.query as { owner?: string }).owner?.trim() || undefined;
    if (!params.channel || !params.userId) return reply.code(400).send({ error: 'channel 与 userId 必填' });
    taskService.deleteUser(params.channel, params.userId, owner);
    channelTokenStore.revokeForUser(params.channel, params.userId);
    return { ok: true };
  });

  // ── 节点管理 REST + 用户偏好（鉴权同 /api/*）──
  const preferenceStore = createPreferenceStore(layout.prefsState);
  registerNodeApi(
    app,
    nodeManager,
    manager,
    preferenceStore,
    (req) => checkAuth(req as FastifyRequest),
    (req) => authGuard.isAdmin(req as FastifyRequest),
    (req) => authGuard.sessionUser(req as FastifyRequest),
  );

  // ── 节点接入指引：登录用户可看；网关 token 仅管理员回显，机器 token 自行颁发 ──
  app.get('/api/nodes/enroll', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authGuard.checkAuth(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      host: gw.server.host,
      port: gw.server.port,
      authEnabled,
      token: authGuard.isAdmin(request) && authEnabled ? auth.token : '',
      defaultAgents: defaultAgentDefinitions().map((d) => ({
        id: d.id,
        ...(d.displayName ? { displayName: d.displayName } : {}),
      })),
    };
  });

  // ── 进程管理（管理员；web 与网关同端口，打开哪台就管哪台）：/api/system/info + /api/pm/* ──
  registerPmApi(app, {
    pm,
    authGuard,
    configPath,
    runtimeGatewayDir,
    onChildGatewayChanged: (section, target) => {
      // zod default 产出只读代理：整体替换对应顶层段，保持网关内存与落盘一致
      if (section === 'weixin') {
        config.weixin = { ...config.weixin, gatewayUrl: target.url || '', gatewayToken: target.token || '' };
      } else {
        config.node = { ...config.node, gatewayUrl: target.url || '', gatewayToken: target.token || '' };
      }
    },
    server: {
      host: gw.server.host,
      port: gw.server.port,
      authEnabled,
      authMode: auth.mode,
      sessionTtlDays: auth.sessionTtlDays,
    },
  });

  // WebSocket 升级：节点连接器连 /api/nodes/ws（复用同一 8787 端口）
  app.server.on('upgrade', (req, socket, head) => nodeManager.handleUpgrade(req, socket, head));

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
    // /v1 专用鉴权：除静态 token / 会话 / 个人 API token 外，还接受任务 key（任务级直连）与渠道用户 token（用户级直连）
    const authState = authGuard.resolveChat(request, request.body as { taskKey?: unknown });
    if (authState.status === 'none') {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }

    const body = request.body;
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return reply.code(400).send(openaiError('请求体需含 model(string) 与 messages(array)', 'invalid_request_error', 'invalid_request'));
    }

    // 用户级凭据作用域校验：ct_ token 只能代表它自己（channel/userId 必须一致），防伪造他人身份
    if (authState.status === 'channelUser') {
      const claimedChannel = typeof body.channel === 'string' ? body.channel.trim() : '';
      const claimedUser = typeof body.userId === 'string' ? body.userId.trim() : '';
      if (claimedChannel && claimedChannel !== authState.channel) {
        return reply.code(403).send(openaiError('该凭据无权访问其他渠道', 'invalid_request_error', 'scope_forbidden'));
      }
      if (claimedUser && claimedUser !== authState.userId) {
        return reply.code(403).send(openaiError('该凭据无权代表其他用户', 'invalid_request_error', 'scope_forbidden'));
      }
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
    // 用户级凭据：强制以凭据归属身份路由（即便 body 没写 channel/userId 也补齐为本人）
    const scopeChannel = authState.status === 'channelUser' ? authState.channel : body.channel;
    const scopeUserId = authState.status === 'channelUser' ? authState.userId : body.userId;
    const loginOwner =
      authState.status === 'session' || authState.status === 'personal' || authState.status === 'local'
        ? authState.user.username
        : undefined;
    const routing = decideTaskRouting(taskService, {
      channel: scopeChannel,
      userId: scopeUserId,
      ownerUsername: body.ownerUsername ?? loginOwner,
      agent: body.agent,
      task: body.task,
      // 任务级凭据：body.taskKey 仅在常规凭据下作为路由字段；Bearer 命中任务时以锁定为准
      taskKey: authState.status === 'task' ? undefined : body.taskKey,
      ...(authState.status === 'task'
        ? {
            lockedTask: {
              channel: authState.channel,
              userId: authState.userId,
              taskId: authState.taskId,
              ...(authState.ownerUsername ? { ownerUsername: authState.ownerUsername } : {}),
            },
          }
        : {}),
      model: body.model,
      text: lastUserText || prompt,
    });
    if (routing.kind === 'notfound') {
      return reply
        .code(404)
        .send(openaiError(`任务不存在: ${body.taskKey ?? ''}`, 'invalid_request_error', 'task_not_found'));
    }
    if (routing.kind === 'disabled') {
      return reply
        .code(403)
        .send(openaiError(`任务 key 已被停用: ${body.taskKey ?? ''}（请联系管理员或换用有效 key）`, 'invalid_request_error', 'key_disabled'));
    }
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

    // 任务路由按 (nodeId, agentId) 解析；非任务（legacy）仍按 model 解析内建 local agent
    let adapter;
    if (routing.kind === 'chat') {
      const resolved = manager.resolveForRouting(routing.nodeId, routing.agentId);
      if (resolved.kind === 'offline') {
        return reply
          .code(503)
          .send(openaiError(`节点离线，任务暂不可用：${resolved.nodeId}（请等待节点重连后重试）`, 'service_unavailable', 'node_offline'));
      }
      if (resolved.kind === 'unknown') {
        return reply
          .code(404)
          .send(openaiError(`节点 ${routing.nodeId} 上没有可用 agent: ${routing.agentId}`, 'invalid_request_error', 'agent_unavailable'));
      }
      adapter = resolved.adapter;
      request.log.info(
        {
          route: 'task',
          nodeId: routing.nodeId,
          agentId: routing.agentId,
          taskId: routing.taskId,
          bodyModel: body.model,
          bodyAgent: typeof body.agent === 'string' ? body.agent : undefined,
          taskKey: typeof body.taskKey === 'string' ? body.taskKey : undefined,
          auth: authState.status,
          stream: body.stream === true,
        },
        'chat task routing',
      );
    } else {
      adapter = manager.resolve(modelForChat);
      if (!adapter) {
        const known = manager.listDescriptors().map((d) => modelIdFor(d.id)).join(', ');
        return reply
          .code(404)
          .send(openaiError(`未知模型 "${modelForChat}"；可用: ${known}`, 'invalid_request_error', 'model_not_found'));
      }
      request.log.info({ route: 'legacy', model: modelForChat, stream: body.stream === true }, 'chat legacy routing');
    }

    const chatRouteMeta =
      routing.kind === 'chat'
        ? { nodeId: routing.nodeId, agentId: routing.agentId, taskId: routing.taskId }
        : { model: modelForChat };

    const chatRequest = {
      messages: [{ role: 'user' as const, content: prompt }],
      ...(sessionKeyForChat ? { sessionKey: sessionKeyForChat } : {}),
      ...(routing.kind === 'chat' && routing.cwd ? { cwd: routing.cwd } : {}),
      ...(routing.kind === 'chat' && routing.env ? { env: routing.env } : {}),
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
        request.log.error({ err, ...chatRouteMeta }, 'agent chat failed');
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
      const offline = err instanceof Error && (err as { code?: string }).code === 'node_offline';
      request.log.error({ err, ...chatRouteMeta }, 'agent chat failed (stream)');
      // 流已开启，无法改状态码：以 SSE error 事件结束
      res.write(
        formatSseData(
          offline
            ? openaiError(message, 'service_unavailable', 'node_offline')
            : openaiError(message, 'server_error', 'agent_error'),
        ),
      );
      res.write(SSE_DONE);
    } finally {
      res.removeListener('close', onAbort);
      res.end();
    }
  });

  // 内置聊天页：仅在没有 web 构建产物时作为 GET / 兜底（有 web 时 / 由管理后台 index.html 提供）。
  if (!webRoot) {
    const chatPage = readFileSync(layout.page('chat'), 'utf8');
    app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(chatPage);
    });
  }

  app.get('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限', 'invalid_request_error', 'forbidden'));
    }
    return { agents: manager.listAgentDetails() };
  });

  /** 节点 + 其上可路由 agent（任务弹窗级联选择用）：local 配置项 + 在线节点自报项 */
  app.get('/api/node-agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    const nodes = nodeManager.list();
    const viewer = {
      admin: authGuard.isAdmin(request),
      username: authGuard.sessionUser(request)?.username,
    };
    return {
      ...(viewer.admin
        ? {
            // local 仅暴露已启用 agent（停用的 agent 不能被任务绑定，与 hasRoutingAgent 校验一致）
            local: {
              nodeId: 'local',
              name: '本机（网关）',
              online: true,
              agents: enrichAgentInfos(
                manager.listAgentDetails().filter((a) => a.enabled).map((a) => ({ id: a.id, displayName: a.displayName })),
              ),
            },
          }
        : {}),
      nodes: nodes.filter((n) => canSeeNode(n, viewer)).map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        online: n.online,
        agents: enrichAgentInfos(n.agents),
      })),
      agents: viewer.admin ? manager.listRoutingAgents() : [],
    };
  });

  /**
   * 按机器（节点）聚合的 agent 开通视图（Agent 管理页）：
   * 本机 local 分组返回完整可编辑运行态；远程机器只返回其连接器自报的只读列表。
   * agent 是「每台机器各自开通」的，网关不能远程改动其他机器的开通情况。
   */
  app.get('/api/agents/by-node', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    const viewer = {
      admin: authGuard.isAdmin(request),
      username: authGuard.sessionUser(request)?.username,
    };
    return {
      defaultAgentId: viewer.admin ? taskService.getDefaultAgentId() : undefined,
      ...(viewer.admin
        ? {
            local: {
              nodeId: LOCAL_NODE_ID,
              name: LOCAL_NODE_NAME,
              online: true,
              status: 'approved' as const,
              agents: manager.listAgentDetails(),
            },
          }
        : {}),
      nodes: nodeManager.list().filter((n) => canSeeNode(n, viewer)).map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        online: n.online,
        ...(n.status ? { status: n.status } : {}),
        agents: enrichAgentInfos(n.agents),
        ...(n.version ? { version: n.version } : {}),
        ...(n.connectedAt ? { connectedAt: n.connectedAt } : {}),
        ...(n.lastSeenAt ? { lastSeenAt: n.lastSeenAt } : {}),
        ...(n.remoteAddress ? { remoteAddress: n.remoteAddress } : {}),
        ...(n.ownerUsername ? { ownerUsername: n.ownerUsername } : {}),
      })),
    };
  });

  /** 全部支持类型目录 + 配置状态（管理后台「支持 ACP 的 Agent 目录」） */
  app.get('/api/agents/catalog', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限', 'invalid_request_error', 'forbidden'));
    }
    return { agents: manager.listAgentCatalog() };
  });

  /** 按目录白名单在本机执行安装命令（无 argv 的类型请复制到终端） */
  app.post('/api/agents/install', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限才能在本机执行安装', 'invalid_request_error', 'forbidden'));
    }
    const body = request.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send(openaiError('请求体需为 JSON 对象', 'invalid_request_error', 'invalid_request'));
    }
    const type = body.type;
    if (typeof type !== 'string') {
      return reply.code(400).send(openaiError('缺少 type', 'invalid_request_error', 'invalid_request'));
    }
    try {
      const result = await runAgentInstall(type);
      return result;
    } catch (err) {
      if (err instanceof AgentInstallError) {
        const status = err.code === 'install_busy' ? 409 : 400;
        return reply.code(status).send(openaiError(err.message, 'invalid_request_error', err.code));
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(openaiError(message, 'server_error', 'install_failed'));
    }
  });

  /** 一键添加 agent：body { type }，按内置目录模板创建、热启用并写入 config.yaml（重启仍加载） */
  app.post('/api/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限才能添加本机 agent', 'invalid_request_error', 'forbidden'));
    }
    const body = request.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send(openaiError('请求体需为 JSON 对象', 'invalid_request_error', 'invalid_request'));
    }
    const type = body.type;
    if (typeof type !== 'string' || !ACP_AGENT_KINDS.includes(type as AcpAgentKind)) {
      return reply.code(400).send(openaiError(`未知 agent 类型: ${String(type)}（支持：${ACP_AGENT_KINDS.join('/')}）`, 'invalid_request_error', 'invalid_request'));
    }
    const kind = type as AcpAgentKind;
    if (manager.listAgentCatalog().some((c) => c.kind === kind && c.configured)) {
      return reply.code(409).send(openaiError(`agent 已配置: ${kind}（可在列表里直接启用）`, 'invalid_request_error', 'agent_exists'));
    }
    const entry = AGENT_CATALOG.find((c) => c.kind === kind);
    if (!entry) {
      return reply.code(400).send(openaiError(`未知 agent 类型: ${kind}`, 'invalid_request_error', 'invalid_request'));
    }
    const def: AgentDefinition = {
      id: kind,
      type: kind,
      displayName: entry.displayName,
      description: entry.description,
      command: entry.command,
    };
    try {
      const agent = manager.addAgent(def);
      const agents = persistAgentEnabled(configPath, kind, true, manager.snapshotDefinitions(), runtimeGatewayDir);
      config.gateway = { ...config.gateway, agents };
      const nodeAgents = persistNodeAgentRegistered(configPath, kind, runtimeGatewayDir);
      config.node = { ...config.node, agents: nodeAgents };
      return { agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send(openaiError(message, 'invalid_request_error', 'invalid_request'));
    }
  });

  app.get('/api/agents/candidates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限', 'invalid_request_error', 'forbidden'));
    }
    const candidates: Record<string, string[]> = {};
    for (const d of manager.listAgentDetails()) candidates[d.id] = collectModelCandidates(d.type);
    return { candidates };
  });

  app.patch('/api/agents/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send(openaiError('无效或缺失 API key（Authorization: Bearer <token>）', 'invalid_request_error', 'unauthorized'));
    }
    if (!authGuard.isAdmin(request)) {
      return reply.code(403).send(openaiError('需要管理员权限才能改本机 agent', 'invalid_request_error', 'forbidden'));
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
      const prevEnabled = manager.listAgentDetails().find((a) => a.id === request.params.id)?.enabled;
      const agent = manager.updateAgent(request.params.id, patch);
      if (patch.enabled !== undefined) {
        try {
          const agents = persistAgentEnabled(
            configPath,
            request.params.id,
            patch.enabled,
            manager.snapshotDefinitions(),
            runtimeGatewayDir,
          );
          config.gateway = { ...config.gateway, agents };
        } catch (err) {
          if (prevEnabled !== undefined) manager.updateAgent(request.params.id, { enabled: prevEnabled });
          throw err;
        }
      }
      return { agent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /未知 agent/.test(message) ? 404 : 500;
      return reply.code(code).send(openaiError(message, 'invalid_request_error', code === 404 ? 'agent_not_found' : 'persist_failed'));
    }
  });

  // ── 个人微信渠道实现三选一 ──
  //  mode=openclaw-weixin-plugin：加载 openclaw-weixin 插件运行时（登录态复用 accounts/）
  //  mode=weixin-bot（默认）：跳过该插件，改由网关进程内拉起独立 adapter（少跑一套插件运行时）
  //  mode=external：跳过插件且网关不内嵌 adapter，由外部进程管理器单独拉起 weixin 进程
  const weixinMode = config.weixin?.mode ?? 'weixin-bot';
  const skipWeixinPlugin = weixinMode === 'weixin-bot' || weixinMode === 'external';
  // 仅 weixin-bot（网关内嵌）才创建句柄；external 由外部进程管理器单独拉起，网关不内嵌
  const embedWeixinBot = weixinMode === 'weixin-bot';
  if (weixinMode === 'external') {
    app.log.info('个人微信走 external 模式：由外部进程管理器单独拉起 weixin 进程，网关不内嵌 adapter');
  }
  const plugins = gw.plugins.filter(
    (p: { package: string; enabled: boolean }) =>
      !(skipWeixinPlugin && p.package === '@tencent-weixin/openclaw-weixin'),
  );
  // 插件运行时读取扁平 config.channels / config.plugins：用 gateway 段构造等价视图
  const effectiveConfig = { ...gw, plugins };

  // ── openclaw 插件运行时（企业微信 / 个人微信渠道）──
  // 配置了 channels.<id> 或 plugins[] 时加载插件包；插件缺失 / 加载失败仅告警，不影响 /v1
  let pluginManager: PluginManager | null = null;
  if (Object.keys(gw.channels).length > 0 || plugins.length > 0) {
    const stateDir = layout.pluginsState;
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
  const embedWeixinLoginUser =
    config.weixin?.accounts?.find((a) => a.trim())?.trim() || config.weixin?.accountId?.trim() || undefined;
  const weixinBot = embedWeixinBot
    ? {
        async start(): Promise<void> {
          weixinBotHandle = await startWeixinBot({
            gatewayUrl: `http://127.0.0.1:${gw.server.port}`,
            model: config.weixin?.model || undefined,
            ...(embedWeixinLoginUser ? { accountId: embedWeixinLoginUser } : {}),
            // 内嵌模式回连本机网关：local/token 模式携带永久 gateway token（回环免登录亦可，但显式带 token 更稳）
            ...(auth.token ? { gatewayToken: auth.token } : {}),
            // 内嵌模式：直接在进程内为每个微信用户签发/复用用户级 token（无需 HTTP 引导）
            userTokenProvider: new InProcessUserTokenProvider((channel, userId) =>
              channelTokenStore.ensure(channel, userId, undefined, embedWeixinLoginUser).token,
            ),
            log: (...args: unknown[]) => app.log.info(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
            errLog: (...args: unknown[]) => app.log.error(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
          });
          app.log.info({ account: weixinBotHandle.account.id }, '[weixin-bot] 个人微信渠道已启动（独立 adapter 模式）');
        },
        async stop(): Promise<void> {
          await weixinBotHandle?.stop().catch(() => {});
          weixinBotHandle = null;
        },
        /** 扫码登录/登出后热重启 adapter（stop + start，monitor 重新读取 accounts/） */
        async reload(): Promise<void> {
          await weixinBotHandle?.stop().catch(() => {});
          weixinBotHandle = null;
          await this.start();
        },
      }
    : null;

  // ── 微信登录管理 API（web 后台扫码登录 / 状态 / 热重启）──
  const weixinLoginService = new WeixinLoginService({ log: (...args: unknown[]) => app.log.info(args.map((a) => String(a)).join(' ')) });
  registerWeixinApi(
    app,
    weixinLoginService,
    (req) => checkAuth(req as FastifyRequest),
    {
      isAdmin: (req) => authGuard.isAdmin(req as FastifyRequest),
      sessionUser: (req) => {
        const u = authGuard.sessionUser(req as FastifyRequest);
        return u ? { username: u.username } : null;
      },
      isProcessRunning: (accountId) => pm.isRunning(`weixin:${accountId}` as ProcessInstanceId),
      log: (...args: unknown[]) => app.log.warn(args.map((a) => String(a)).join(' ')),
      async onBound(accountId) {
        channelTokenStore.revokeForOwner('weixin', accountId);
        weixinLoginService.clearChannelTokenCache(accountId);
        taskService.rotateKeysOnWeixinBind(accountId);
        const accounts = persistEnsureWeixinAccount(configPath, accountId, runtimeGatewayDir);
        config.weixin = { ...config.weixin, accounts, mode: 'external' };
        if (weixinBot) await weixinBot.stop().catch(() => {});
        // start 遇已运行会跳过，旧进程内存里仍持有 ct_；必须重启才能丢掉缓存
        await pm.restart([`weixin:${accountId}` as ProcessInstanceId]);
      },
      async restartAccount(accountId) {
        const accounts = persistEnsureWeixinAccount(configPath, accountId, runtimeGatewayDir);
        config.weixin = { ...config.weixin, accounts, mode: 'external' };
        if (weixinBot) await weixinBot.stop().catch(() => {});
        await pm.restart([`weixin:${accountId}` as ProcessInstanceId]);
      },
      async onUnbound(accountId) {
        channelTokenStore.revokeForOwner('weixin', accountId);
        const next = persistRemoveWeixinAccount(configPath, accountId, runtimeGatewayDir);
        config.weixin = { ...config.weixin, accounts: next };
        await pm.stop([`weixin:${accountId}` as ProcessInstanceId]);
        if (weixinBot) await weixinBot.stop().catch(() => {});
      },
      reloadBot: weixinBot ? () => weixinBot.reload() : undefined,
      ...(weixinMode === 'external'
        ? {
            reloadUnavailableMessage:
              '微信由进程管理器托管（external 模式），请在管理后台「本机 · 进程」页对对应账号实例执行重启，' +
              `或在本机运行 ${layout.restartWeixinHint}（多账号可用 pm restart weixin:<accountId>）`,
          }
        : {}),
    },
  );

  // 管理后台静态资源最后挂载（prefix /），避免抢在 /v1、/api 等路由之前。
  if (webRoot) {
    app.get('/admin', async (_req, reply) => reply.redirect('/'));
    app.get('/admin/*', async (request, reply) => {
      const wildcard = (request.params as { '*'?: string })['*'] ?? '';
      return reply.redirect(`/${wildcard}`);
    });
    app.get('/ui', async (_req, reply) => reply.redirect('/'));
    app.get('/ui/*', async (request, reply) => {
      const wildcard = (request.params as { '*'?: string })['*'] ?? '';
      return reply.redirect(`/${wildcard}`);
    });
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.log.info({ webRoot }, 'web 管理端已挂载到 /');
  }

  return { app, manager, nodeManager, pluginManager, taskService, weixinBot, host: gw.server.host, port: gw.server.port, authEnabled };
}

async function main(): Promise<void> {
  const { app, manager, nodeManager, pluginManager, weixinBot, host, port, authEnabled } = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await weixinBot?.stop().catch(() => {});
    await pluginManager?.dispose().catch(() => {});
    await nodeManager.dispose().catch(() => {});
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
      app.log.error({ err }, `weixin-bot 启动失败（/v1 不受影响）；${getLayout().loginHint}`);
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
