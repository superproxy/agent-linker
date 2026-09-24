/**

 * OpenClaw 插件 agentDispatch 桥：入站 ctx 已路由为 agentId + sessionKey，

 * 统一 POST 主网关 /v1/chat/completions（SSE），与 weixin-bot 薄 adapter 同后端。

 *

 * 有 channel+userId 时走网关 decideTaskRouting（激活 taskId + sessionKey），

 * 不用 OpenClaw agentId / agent:pi 决定模型；model 字段仅为 OpenAI 兼容占位。

 */

import type { ChannelAgentDispatch } from '@linkagent/shared';

import { streamChat, GatewayUnauthorizedError } from './gateway-chat.js';
import type { UserTokenProvider } from './user-token.js';
import { emitChannelDispatchTrace, newDispatchTraceId } from '../store/dispatch-trace.js';



/** /v1 body.model 占位：任务路由命中时网关忽略该字段 */

export const TASK_ROUTED_MODEL_PLACEHOLDER = 'linkagent-task-routed';



export interface V1AgentDispatchOptions {

  gatewayUrl: string;

  gatewayToken?: string;

  /** 无法解析 channel/userId 时的 legacy model（OpenClaw 无任务路由） */

  legacyModel: string;

  ownerUsername?: string;

  /** 任务路由渠道（wecom/weixin 等）按终端用户 ct_ 调 /v1；缺省仍用 gatewayToken */
  userTokenProvider?: UserTokenProvider;

  /** 派发失败时打日志（channel-gateway 进程无 Fastify logger） */

  onDispatchError?: (info: { sessionKey: string; err: unknown }) => void;

}



/** 从 OpenClaw buildAgentSessionKey 或 legacy key 解析 channel / userId */

export function parseSessionRouting(sessionKey: string): {

  channel?: string;

  userId?: string;

  legacySessionKey?: string;

} {

  const sk = sessionKey.trim();

  if (!sk) return {};



  const openClaw = /^agent:[^:]+:([^:]+):([^:]*):direct:(.+)$/i.exec(sk);

  if (openClaw) {

    const channel = openClaw[1]?.toLowerCase();

    const userId = openClaw[3]?.trim();

    if (channel && userId) return { channel, userId };

  }



  const head = sk.split(':')[0]?.toLowerCase();

  if (head === 'wecom' || head === 'weixin' || head === 'feishu' || head === 'lark') {

    const channel = head === 'lark' ? 'feishu' : head;

    const userId = sk.slice(head.length + 1).trim();

    if (userId) return { channel, userId, legacySessionKey: sk };

  }



  return { legacySessionKey: sk };

}



export function createV1AgentDispatch(opts: V1AgentDispatchOptions): ChannelAgentDispatch {

  const base = opts.gatewayUrl.replace(/\/$/, '');

  const token = opts.gatewayToken?.trim() ?? '';

  const legacyModel = opts.legacyModel.trim() || TASK_ROUTED_MODEL_PLACEHOLDER;

  const ownerUsername = opts.ownerUsername?.trim() ?? '';
  const userTokenProvider = opts.userTokenProvider;
  const staticToken = token;



  return {

    async chat({ agentId, sessionKey, accountId, text, attachments }, cb) {

      let prompt = text;

      if (attachments?.length) {

        const refs = attachments.map((a) => `[附件: ${a.name} (${a.url})]`).join('\n');

        prompt = prompt ? `${prompt}\n\n${refs}` : refs;

      }

      if (!prompt.trim()) return;

      const traceId = newDispatchTraceId();
      const route = parseSessionRouting(sessionKey);

      const taskRouting = Boolean(route.channel && route.userId);

      emitChannelDispatchTrace('channels.inbound', {
        traceId,
        sessionKey,
        accountId,
        channel: route.channel,
        userId: route.userId,
        taskRouting,
        textLen: prompt.length,
      });



      const model = taskRouting

        ? TASK_ROUTED_MODEL_PLACEHOLDER

        : agentId.trim()

          ? `agent:${agentId.replace(/^agent:/i, '')}`

          : legacyModel;



      const runOnce = async (forceToken: boolean) => {
        let gatewayToken = staticToken;
        let tokenSource: 'ct' | 'static' | 'none' = staticToken ? 'static' : 'none';
        if (taskRouting && route.channel && route.userId && userTokenProvider) {
          gatewayToken = await userTokenProvider.resolve(route.channel, route.userId, forceToken);
          tokenSource = 'ct';
          emitChannelDispatchTrace('channels.token', {
            traceId,
            channel: route.channel,
            userId: route.userId,
            force: forceToken,
            ok: Boolean(gatewayToken),
          });
        }
        emitChannelDispatchTrace('channels.v1.request', {
          traceId,
          channel: route.channel,
          userId: route.userId,
          owner: ownerUsername || undefined,
          token: tokenSource,
          model,
        });
        let replyChars = 0;
        const out = await streamChat({
          gatewayUrl: base,
          model,
          message: prompt,
          traceId,
          ...(gatewayToken ? { gatewayToken } : {}),
          ...(taskRouting
            ? {
                channel: route.channel,
                userId: route.userId,
                ...(ownerUsername ? { ownerUsername } : {}),
              }
            : route.legacySessionKey && !route.channel
              ? { sessionKey: `${accountId}::${route.legacySessionKey}` }
              : route.legacySessionKey && route.channel
                ? { sessionKey: route.legacySessionKey }
                : !route.channel
                  ? { sessionKey: `${accountId}::${sessionKey}` }
                  : {}),
          onReasoning: (d) => cb.onReasoning?.(d),
          onText: (d) => {
            replyChars += d.length;
            cb.onText(d);
          },
        });
        replyChars = Math.max(replyChars, out.text.length);
        emitChannelDispatchTrace('channels.v1.response', {
          traceId,
          ok: true,
          replyChars,
          reasoningChars: out.reasoning.length,
        });
      };

      try {
        try {
          await runOnce(false);
        } catch (err) {
          if (
            err instanceof GatewayUnauthorizedError &&
            taskRouting &&
            route.channel &&
            route.userId &&
            userTokenProvider
          ) {
            emitChannelDispatchTrace('channels.v1.retry', { traceId, reason: '401' });
            await runOnce(true);
            return;
          }
          throw err;
        }
      } catch (err) {
        emitChannelDispatchTrace('channels.v1.fail', {
          traceId,
          error: err instanceof Error ? err.message : String(err),
        });
        opts.onDispatchError?.({ sessionKey, err });
        throw err;
      }

    },

  };

}


