/**
 * 企业微信 botAgent（方案 B：自建应用 HTTP 回调模式，不依赖 openclaw 插件运行时）。
 *
 * 架构：
 *   企微用户 ⇄ 企微服务器 POST 加密 XML 回调 ⇄ botAgent(HTTP server) ⇄ POST /v1/chat/completions (SSE)
 *                                              ⇄ SSE 解析 reasoning(思考) + content(正文)
 *                                              ⇄ qyapi message/send 主动推回
 *
 * 回调协议（企业微信自建应用「接收消息」标准）：
 *   - GET  /<path>?msg_signature&timestamp&nonce&echostr  URL 验证（验签 → 解密 echostr → 明文返回）
 *   - POST /<path>?msg_signature&timestamp&nonce          消息回调（body 为 <xml><Encrypt>…</Encrypt></xml>，
 *     验签 → AES 解密 → 解析消息 XML → 5s 内回 "success" 防重试，异步调网关）
 *   加解密/验签复用官方 @wecom/aibot-node-sdk 的 WecomCrypto（AES-256-CBC + SHA1 签名）。
 *
 * 主动回复：POST qyapi.weixin.qq.com/cgi-bin/message/send?access_token=<token>
 *   access_token 由 gettoken 获取（7200s 有效），内存缓存 + 提前 60s 刷新。
 *   text 消息 content 上限 2048 字节（按 UTF-8 字节切块，中文 3 字节/字）。
 *
 * 多轮会话：sessionKey = "wecom:user:<userid>"（单聊）/ "wecom:chat:<chatid>"（群聊）
 * → 网关持久会话（有记忆）。
 *
 * 运行：pnpm --filter @linkagent/backend bot:wecom
 * 环境变量：
 *   WECOM_CORP_ID     企业 ID（必填）
 *   WECOM_AGENT_ID    自建应用 AgentId（必填）
 *   WECOM_SECRET      自建应用 Secret（必填）
 *   WECOM_TOKEN       接收消息服务器 Token（必填）
 *   WECOM_AES_KEY     EncodingAESKey 43 位（必填）
 *   WECOM_PORT        回调 HTTP 端口（默认 8798）
 *   WECOM_CALLBACK_PATH  回调路径（默认 /wecom/callback）
 *   LINKAGENT_GATEWAY_URL  网关 base（默认 http://127.0.0.1:8787）
 *   LINKAGENT_GATEWAY_MODEL 模型（默认 agent:pi；agent:opencode 默认启动即崩溃，见 weixin-bot 说明）
 *
 * 企业微信后台配置：应用管理 → 自建应用 → 接收消息 → 设置 API 接收
 *   URL = http(s)://<公网>/<path>，Token/EncodingAESKey 与上面对应。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WecomCrypto } from '@wecom/aibot-node-sdk';
import { runChatSession, streamChat } from './gateway-chat.js';
import { TaskRouter } from './task-router.js';

// ── 配置 ──────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`缺少环境变量 ${name}（企微自建应用配置）`);
  }
  return v.trim();
}

const CORP_ID = requireEnv('WECOM_CORP_ID');
const AGENT_ID = requireEnv('WECOM_AGENT_ID');
const AGENT_ID_NUM = Number(AGENT_ID);
if (!Number.isFinite(AGENT_ID_NUM)) throw new Error(`WECOM_AGENT_ID 需为数字，当前: ${AGENT_ID}`);
const SECRET = requireEnv('WECOM_SECRET');
const TOKEN = requireEnv('WECOM_TOKEN');
const AES_KEY = requireEnv('WECOM_AES_KEY');
if (AES_KEY.length !== 43) {
  throw new Error(`WECOM_AES_KEY 应为 43 位（企微后台生成），当前 ${AES_KEY.length} 位`);
}
const PORT = Number(process.env.WECOM_PORT ?? 8798);
const CALLBACK_PATH = (process.env.WECOM_CALLBACK_PATH ?? '/wecom/callback').replace(/\/$/, '') || '/wecom/callback';
const GATEWAY_URL = process.env.LINKAGENT_GATEWAY_URL ?? 'http://127.0.0.1:8787';
const GATEWAY_MODEL = process.env.LINKAGENT_GATEWAY_MODEL ?? 'agent:pi';

/** text 消息 content 上限（企业微信：2048 字节） */
const TEXT_MAX_BYTES = 2048;
/** 回调消息去重窗口（企微可能重试推送同一 MsgId） */
const MSG_ID_DEDUP = new Set<string>();
const DEDUP_MAX = 500;
/** 每用户串行队列 */
const userChains = new Map<string, Promise<void>>();

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
// 单聊任务路由层：选中任务缓存（网关 /api/tasks 为单一事实源）
const router = new TaskRouter({ gatewayUrl: GATEWAY_URL, channel: 'wecom' });
const errLog = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

const crypto = new WecomCrypto(TOKEN, AES_KEY, CORP_ID);

// ── 极简 XML 提取（企微回调结构固定） ────────────────────────────────
function extractTag(xml: string, tag: string): string {
  // 优先 CDATA 形式 <Tag><![CDATA[val]]></Tag>
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdata) return cdata[1] ?? '';
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain?.[1] ?? '';
}

/** 回调 POST body（<xml><Encrypt>…</Encrypt></xml>）中提取密文 */
function extractEncrypt(xml: string): string {
  return extractTag(xml, 'Encrypt');
}

interface WecomMessage {
  toUserName: string;
  fromUserName: string;
  createTime: string;
  msgType: string;
  content: string;
  msgId: string;
  agentId: string;
  chatId?: string;
}

/** 解密后的消息 XML → 结构化（单聊 + 群聊） */
function parseMessageXml(xml: string): WecomMessage {
  return {
    toUserName: extractTag(xml, 'ToUserName'),
    fromUserName: extractTag(xml, 'FromUserName'),
    createTime: extractTag(xml, 'CreateTime'),
    msgType: extractTag(xml, 'MsgType'),
    content: extractTag(xml, 'Content'),
    msgId: extractTag(xml, 'MsgId'),
    agentId: extractTag(xml, 'AgentID'),
    chatId: extractTag(xml, 'ChatId') || undefined,
  };
}

// ── access_token 缓存 + 主动推送 ─────────────────────────────────────
let tokenCache: { token: string; expiresAt: number; refreshPromise: Promise<string> | null } = {
  token: '',
  expiresAt: 0,
  refreshPromise: null,
};

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  if (tokenCache.refreshPromise) return tokenCache.refreshPromise;
  tokenCache.refreshPromise = (async () => {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(CORP_ID)}&corpsecret=${encodeURIComponent(SECRET)}`;
    const res = await fetch(url);
    const json = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error(`gettoken 失败: ${json.errcode} ${json.errmsg}`);
    }
    tokenCache.token = json.access_token;
    tokenCache.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
    return json.access_token;
  })();
  try {
    return await tokenCache.refreshPromise;
  } finally {
    tokenCache.refreshPromise = null;
  }
}

/** 主动推送文本给成员（message/send；单聊/群聊触发均推送到该成员的应用会话） */
async function sendWecomText(toUser: string, content: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: AGENT_ID_NUM,
        text: { content },
      }),
    },
  );
  const json = (await res.json()) as { errcode?: number; errmsg?: string; invaliduser?: string };
  if (json.errcode !== 0) {
    throw new Error(`message/send 失败: ${json.errcode} ${json.errmsg}${json.invaliduser ? ` invaliduser=${json.invaliduser}` : ''}`);
  }
  if (json.invaliduser) {
    throw new Error(`message/send 部分失败: invaliduser=${json.invaliduser}`);
  }
}

/** 按 UTF-8 字节切块（企微 text 上限 2048 字节） */
function splitByBytes(text: string, maxBytes = TEXT_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > maxBytes && cur) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── 消息处理 ─────────────────────────────────────────────────────────
async function handleWecomMessage(msg: WecomMessage): Promise<void> {
  const from = msg.fromUserName;
  if (!from) return;
  const text = msg.content?.trim();
  if (!text) {
    log(`[wecom] 跳过非文本消息 type=${msg.msgType} from=${from}`);
    return;
  }
  log(`[wecom] inbound from=${from}${msg.chatId ? ` chat=${msg.chatId}` : ''} text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);

  // 群聊：多人窗口不套用个人任务路由，保持原 chat 维度会话
  if (msg.chatId) {
    await runChatSession({
      gatewayUrl: GATEWAY_URL,
      model: GATEWAY_MODEL,
      sessionKey: `wecom:chat:${msg.chatId}`,
      message: text,
      send: (chunk) => sendWecomText(from, chunk),
      split: splitByBytes,
      log,
    });
    return;
  }

  // 单聊：任务路由（命令 → 网关本地解析回文本；普通消息 → 激活任务）
  const isCmd = TaskRouter.isCommand(text);
  const route = isCmd ? null : await router.active(from);
  await runChatSession({
    gatewayUrl: GATEWAY_URL,
    model: GATEWAY_MODEL,
    channel: 'wecom',
    userId: from,
    message: text,
    ...(!isCmd && route ? { agent: route.agent, task: route.task } : {}),
    send: (chunk) => sendWecomText(from, chunk),
    split: splitByBytes,
    log,
  });
  if (isCmd) router.invalidate(from);
}

function enqueue(from: string, task: () => Promise<void>): void {
  const prev = userChains.get(from) ?? Promise.resolve();
  const next = prev.then(task, task).catch(() => {}); // 单条失败不阻断队列
  userChains.set(
    from,
    next.finally(() => {
      if (userChains.get(from) === next) userChains.delete(from);
    }),
  );
}

function dedupMsgId(msgId: string): boolean {
  if (!msgId) return false;
  if (MSG_ID_DEDUP.has(msgId)) return true;
  MSG_ID_DEDUP.add(msgId);
  if (MSG_ID_DEDUP.size > DEDUP_MAX) {
    const first = MSG_ID_DEDUP.values().next().value as string | undefined;
    if (first) MSG_ID_DEDUP.delete(first);
  }
  return false;
}

// ── HTTP 回调 ────────────────────────────────────────────────────────
async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error('payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== CALLBACK_PATH) {
    sendText(res, 404, 'not found');
    return;
  }
  const signature = url.searchParams.get('msg_signature') ?? url.searchParams.get('msgsignature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';

  // ── GET: URL 验证（echostr） ────────────────────────────────────
  if (req.method === 'GET') {
    const echostr = url.searchParams.get('echostr') ?? '';
    if (!crypto.verifySignature(signature, timestamp, nonce, echostr)) {
      sendText(res, 401, 'signature verification failed');
      return;
    }
    try {
      const plain = crypto.decrypt(echostr);
      sendText(res, 200, plain);
      log('[wecom] URL 验证通过');
    } catch (err) {
      errLog('[wecom] echostr 解密失败:', err instanceof Error ? err.message : err);
      sendText(res, 400, 'decrypt failed');
    }
    return;
  }

  // ── POST: 消息回调 ──────────────────────────────────────────────
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendText(res, 400, `read body failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const encrypted = extractEncrypt(body);
  if (!encrypted) {
    sendText(res, 400, 'missing Encrypt');
    return;
  }
  if (!crypto.verifySignature(signature, timestamp, nonce, encrypted)) {
    sendText(res, 401, 'signature verification failed');
    return;
  }
  let decrypted: string;
  try {
    decrypted = crypto.decrypt(encrypted);
  } catch (err) {
    errLog('[wecom] 消息解密失败:', err instanceof Error ? err.message : err);
    sendText(res, 400, 'decrypt failed');
    return;
  }
  const msg = parseMessageXml(decrypted);
  // 5s 内必须响应（防重试），异步处理
  sendText(res, 200, 'success');
  log(`[wecom] 回调 from=${msg.fromUserName} type=${msg.msgType} agentId=${msg.agentId}`);

  if (msg.msgType !== 'text') {
    log(`[wecom] 忽略非 text 回调 type=${msg.msgType}`);
    return;
  }
  if (dedupMsgId(msg.msgId)) {
    log(`[wecom] 重复回调 MsgId=${msg.msgId}，跳过`);
    return;
  }
  enqueue(msg.fromUserName, () => handleWecomMessage(msg));
}

// ── 启动 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  log(`[wecom] corp=${CORP_ID} agent=${AGENT_ID_NUM}`);
  log(`[wecom] 网关 ${GATEWAY_URL}  模型 ${GATEWAY_MODEL}`);
  log(`[wecom] 回调 http://0.0.0.0:${PORT}${CALLBACK_PATH}`);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      errLog('[wecom] 请求处理异常:', err instanceof Error ? err.message : err);
      try {
        sendText(res, 500, 'internal error');
      } catch {
        /* res 已结束 */
      }
    });
  });

  // 启动前先验证 access_token 可获取（配置错误尽早暴露）
  try {
    const token = await getAccessToken();
    log(`[wecom] access_token 获取成功（${token.length} 字符，提前验证通过）`);
  } catch (err) {
    errLog('[wecom] 警告: access_token 获取失败（后台配置问题，回调仍可收但无法推送）:', err instanceof Error ? err.message : err);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve());
  });
  log(`[wecom] 回调服务已启动`);

  const shutdown = (signal: string) => {
    log(`[wecom] 收到 ${signal}，优雅退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  errLog('[wecom] 启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
