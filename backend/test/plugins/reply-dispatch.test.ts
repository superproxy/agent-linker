import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReplyWithBufferedBlockDispatcher } from '../../src/plugins/runtime/channel/reply.js';
import type { ChannelAgentDispatch } from '@linkagent/shared';

test('dispatchReplyWithBufferedBlockDispatcher：企微会话键不含 agent:pi，agent 不由插件指定', async () => {
  let seenAgentId = '';
  let seenSessionKey = '';
  const dispatch: ChannelAgentDispatch = {
    async chat(params, cb) {
      seenAgentId = params.agentId;
      seenSessionKey = params.sessionKey;
      cb.onText('ok');
    },
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: {
        Body: '你好',
        OriginatingChannel: 'wecom',
        AccountId: 'default',
        From: 'wecom:ZhangSan',
        ChatType: 'direct',
        AgentId: 'pi',
        SessionKey: 'agent:pi:wecom:default:direct:ZhangSan',
      },
      cfg: { channels: { wecom: { agentId: 'pi' } } },
      dispatcherOptions: {
        deliver: () => {},
      },
    },
    dispatch,
  );
  assert.equal(seenAgentId, '');
  assert.equal(seenSessionKey, 'wecom:zhangsan');
});

test('dispatchReplyWithBufferedBlockDispatcher：deliver 带 info.kind，避免企微插件读 undefined', async () => {
  const seen: Array<{ text?: string; kind?: string }> = [];
  const dispatch: ChannelAgentDispatch = {
    async chat(_params, cb) {
      cb.onText('任务列表');
    },
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: { Body: '/task list', OriginatingChannel: 'wecom', From: 'u1' },
      dispatcherOptions: {
        deliver: (payload, info) => {
          seen.push({ text: payload.text, kind: info?.kind });
        },
      },
    },
    dispatch,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.text, '任务列表');
  assert.equal(seen[0]?.kind, 'block');
});

test('dispatchReplyWithBufferedBlockDispatcher：异步 deliver 在返回前结束，避免企微先发「已收到」', async () => {
  let landed = false;
  const dispatch: ChannelAgentDispatch = {
    async chat(_params, cb) {
      cb.onText('正文');
    },
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: { Body: '你好', OriginatingChannel: 'wecom', From: 'u1' },
      dispatcherOptions: {
        deliver: async () => {
          await new Promise((r) => setTimeout(r, 20));
          landed = true;
        },
      },
    },
    dispatch,
  );
  assert.equal(landed, true);
});

test('dispatchReplyWithBufferedBlockDispatcher：企微先 onReplyStart，思考包在 think 里', async () => {
  const order: string[] = [];
  const texts: string[] = [];
  const dispatch: ChannelAgentDispatch = {
    async chat(_params, cb) {
      order.push('chat');
      cb.onReasoning('先想');
      cb.onText('答案');
    },
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: { Body: '你好', OriginatingChannel: 'wecom', From: 'u1' },
      dispatcherOptions: {
        onReplyStart: async () => {
          order.push('start');
        },
        deliver: (payload) => {
          if (payload.text) texts.push(payload.text);
        },
      },
    },
    dispatch,
  );
  assert.deepEqual(order, ['start', 'chat']);
  assert.equal(texts[0], '<think>先想</think>');
  assert.equal(texts[1], '答案');
});

test('dispatchReplyWithBufferedBlockDispatcher：企微无正文时交付可见兜底，避免插件发「已收到」', async () => {
  const texts: string[] = [];
  const dispatch: ChannelAgentDispatch = {
    async chat() {},
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: { Body: '你好', OriginatingChannel: 'wecom', From: 'u1' },
      dispatcherOptions: {
        deliver: (payload) => {
          if (payload.text) texts.push(payload.text);
        },
      },
    },
    dispatch,
  );
  assert.deepEqual(texts, ['没有生成回复，请重试。']);
});
