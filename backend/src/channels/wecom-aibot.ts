/**
 * 企业微信智能机器人：官方 @wecom/aibot-node-sdk 长连接。
 * 不加载 @wecom/wecom-openclaw-plugin。凭证是 channels.yaml 里的 botId + secret。
 * 自建应用 HTTP 回调仍走 wecom-bot.ts（bot:wecom），凭证不同。
 */
import { randomUUID } from 'node:crypto';
import { WSClient } from '@wecom/aibot-node-sdk';
import { runChatSession } from './gateway-chat.js';
import type { UserTokenProvider } from './user-token.js';

const TEXT_MAX_BYTES = 2048;

export interface WecomAibotOptions {
  botId: string;
  secret: string;
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
  ownerUsername?: string;
  userTokenProvider?: UserTokenProvider;
  log?: (...args: unknown[]) => void;
  errLog?: (...args: unknown[]) => void;
}

export interface WecomAibotHandle {
  stop(): Promise<void>;
}

interface WecomTextBody {
  msgid?: string;
  chattype?: string;
  chatid?: string;
  from?: { userid?: string };
  text?: { content?: string };
}

export function wecomPeerId(body: WecomTextBody): string {
  if (body.chattype === 'group' && body.chatid?.trim()) return body.chatid.trim();
  return body.from?.userid?.trim() ?? '';
}

function splitByBytes(text: string, maxBytes = TEXT_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (curBytes + size > maxBytes && cur) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += size;
  }
  if (cur) chunks.push(cur);
  return chunks.length > 0 ? chunks : [text];
}

async function bearerFor(
  opts: WecomAibotOptions,
  userId: string,
  log: (...args: unknown[]) => void,
): Promise<string> {
  if (opts.userTokenProvider) {
    const token = await opts.userTokenProvider.resolve('wecom', userId, false).catch((err: unknown) => {
      log('[wecom] 解析用户 token 失败，回退静态 token:', err instanceof Error ? err.message : err);
      return '';
    });
    if (token) return token;
  }
  return opts.gatewayToken;
}

export async function startWecomAibot(opts: WecomAibotOptions): Promise<WecomAibotHandle> {
  const botId = opts.botId.trim();
  const secret = opts.secret.trim();
  if (!botId || !secret) throw new Error('企微智能机器人缺少 botId 或 secret');

  const log = opts.log ?? ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const errLog = opts.errLog ?? ((...args: unknown[]) => console.error(new Date().toISOString(), ...args));
  const client = new WSClient({
    botId,
    secret,
    maxReconnectAttempts: -1,
  });

  client.on('connected', () => log('[wecom] WebSocket 已连接'));
  client.on('authenticated', () => log(`[wecom] 认证成功 botId=${botId}`));
  client.on('disconnected', (reason: string) => log(`[wecom] 连接断开 ${reason}`));
  client.on('reconnecting', (attempt: number) => log(`[wecom] 重连第 ${attempt} 次`));
  client.on('error', (error: Error) => errLog('[wecom] 长连接错误:', error.message));
  client.on('message.text', (frame) => {
    const body = frame.body as WecomTextBody | undefined;
    if (!body) return;
    const text = body.text?.content?.trim() ?? '';
    const peer = wecomPeerId(body);
    if (!text || !peer) return;
    log(`[wecom] inbound peer=${peer} text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    const streamId = body.msgid?.trim() || randomUUID();
    let acc = '';
    void (async () => {
      const gatewayToken = await bearerFor(opts, peer, log);
      await runChatSession({
        gatewayUrl: opts.gatewayUrl,
        model: opts.model,
        gatewayToken,
        channel: 'wecom',
        userId: peer,
        ...(opts.ownerUsername ? { ownerUsername: opts.ownerUsername } : {}),
        message: text,
        send: async (chunk) => {
          acc += chunk;
          await client.replyStream(frame, streamId, acc, false);
        },
        split: splitByBytes,
        log,
      });
      if (acc) await client.replyStream(frame, streamId, acc, true);
    })().catch((err: unknown) => {
      errLog('[wecom] 处理消息失败:', err instanceof Error ? err.message : err);
    });
  });

  client.connect();
  log(`[wecom] 长连接已发起 botId=${botId}`);

  return {
    async stop() {
      client.disconnect();
    },
  };
}
