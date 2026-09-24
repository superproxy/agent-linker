/**
 * 飞书 bot：官方长连接，不加载 @openclaw/feishu。
 * 飞书用户 → WSClient → runChatSession → 网关 /v1 → im.v1.message.reply。
 */
import { createRequire } from 'node:module';
import { GatewayUnauthorizedError, runChatSession } from './gateway-chat.js';
import { emitChannelDispatchTrace, newDispatchTraceId } from '../store/dispatch-trace.js';
import type { UserTokenProvider } from './user-token.js';

const require = createRequire(import.meta.url);

interface FeishuEventMessage {
  message_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
}

interface FeishuEventData {
  message?: FeishuEventMessage;
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
}

interface LarkSdk {
  Client: new (opts: { appId: string; appSecret: string }) => {
    im: {
      v1: {
        message: {
          reply: (payload: {
            path: { message_id: string };
            data: { msg_type: string; content: string };
          }) => Promise<unknown>;
        };
      };
    };
  };
  WSClient: new (opts: { appId: string; appSecret: string; loggerLevel?: number }) => {
    start(params: { eventDispatcher: unknown }): Promise<void>;
    close(params?: { force?: boolean }): void;
  };
  EventDispatcher: new (opts: object) => {
    register(handlers: Record<string, (data: FeishuEventData) => Promise<void> | void>): unknown;
  };
  LoggerLevel: { info: number };
}

const TEXT_CHUNK = 1500;

function loadLark(): LarkSdk {
  return require('@larksuiteoapi/node-sdk') as LarkSdk;
}

export interface FeishuBotOptions {
  appId: string;
  appSecret: string;
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
  ownerUsername?: string;
  userTokenProvider?: UserTokenProvider;
  log?: (...args: unknown[]) => void;
  errLog?: (...args: unknown[]) => void;
}

export interface FeishuBotHandle {
  stop(): Promise<void>;
}

export function feishuTextFromContent(messageType: string, content: string): string {
  if (messageType !== 'text') return '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TEXT_CHUNK) chunks.push(text.slice(i, i + TEXT_CHUNK));
  return chunks.length > 0 ? chunks : [text];
}

async function bearerFor(
  opts: FeishuBotOptions,
  userId: string,
  force: boolean,
  log: (...args: unknown[]) => void,
): Promise<string> {
  if (opts.userTokenProvider) {
    const token = await opts.userTokenProvider.resolve('feishu', userId, force).catch((err: unknown) => {
      log('[feishu] 解析用户 token 失败，回退静态 token:', err instanceof Error ? err.message : err);
      return '';
    });
    if (token) return token;
  }
  return opts.gatewayToken;
}

export async function startFeishuBot(opts: FeishuBotOptions): Promise<FeishuBotHandle> {
  const appId = opts.appId.trim();
  const appSecret = opts.appSecret.trim();
  if (!appId || !appSecret) throw new Error('飞书 bot 缺少 appId 或 appSecret');

  const log = opts.log ?? ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const errLog = opts.errLog ?? ((...args: unknown[]) => console.error(new Date().toISOString(), ...args));
  const seen = new Set<string>();
  const lark = loadLark();
  const client = new lark.Client({ appId, appSecret });
  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const message = data.message;
      const sender = data.sender;
      if (!message || sender?.sender_type === 'bot') return;
      const messageId = message.message_id;
      if (!messageId || seen.has(messageId)) return;
      seen.add(messageId);
      if (seen.size > 500) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }
      const chatType = message.chat_type;
      if (chatType !== 'p2p' && chatType !== 'private') {
        log(`[feishu] 跳过非单聊 chat_type=${chatType ?? ''}`);
        return;
      }
      const openId = sender?.sender_id?.open_id?.trim() ?? '';
      const text = feishuTextFromContent(message.message_type ?? '', message.content ?? '');
      if (!openId || !text) {
        log(`[feishu] 跳过无文本或无 open_id message=${messageId}`);
        return;
      }
      const traceId = newDispatchTraceId();
      log(`[feishu] inbound open_id=${openId} text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
      emitChannelDispatchTrace('channels.inbound', {
        traceId,
        source: 'feishu-bot',
        channel: 'feishu',
        userId: openId,
        owner: opts.ownerUsername,
        textLen: text.length,
      });
      const send = async (chunk: string) => {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        });
      };
      const runOnce = async (forceToken: boolean) => {
        const gatewayToken = await bearerFor(opts, openId, forceToken, log);
        return runChatSession({
          gatewayUrl: opts.gatewayUrl,
          model: opts.model,
          channel: 'feishu',
          userId: openId,
          ...(opts.ownerUsername ? { ownerUsername: opts.ownerUsername } : {}),
          message: text,
          traceId,
          source: 'feishu-bot',
          ...(gatewayToken ? { gatewayToken } : {}),
          send,
          split: splitText,
          maxTextChars: 512,
          log,
        });
      };
      // 长连接回调要尽快返回，对话放到后台
      void (async () => {
        let out;
        try {
          out = await runOnce(false);
        } catch (err) {
          if (err instanceof GatewayUnauthorizedError && opts.userTokenProvider) {
            log(`[feishu] 用户 token 401，刷新后重试 open_id=${openId}`);
            out = await runOnce(true);
          } else {
            throw err;
          }
        }
        if (out.text.trim()) {
          log(`[feishu] outbound open_id=${openId} len=${out.text.length}`);
          emitChannelDispatchTrace('channels.reply', {
            traceId,
            channel: 'feishu',
            userId: openId,
            delivered: true,
            replyChars: out.text.length,
          });
        } else if (!out.reasoning.trim()) {
          log(`[feishu] 网关无输出 open_id=${openId}`);
          emitChannelDispatchTrace('channels.reply', {
            traceId,
            channel: 'feishu',
            userId: openId,
            delivered: false,
          });
        }
      })().catch((err: unknown) => {
        errLog('[feishu] 处理消息失败:', err instanceof Error ? err.message : err);
      });
    },
  });

  wsClient.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
    errLog('[feishu] 长连接退出:', err instanceof Error ? err.message : err);
  });
  log(`[feishu] 长连接已发起 appId=${appId}`);

  return {
    async stop() {
      wsClient.close({ force: true });
    },
  };
}
