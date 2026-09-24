import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReplyWithBufferedBlockDispatcher } from '../../src/plugins/runtime/channel/reply.js';
import type { ChannelAgentDispatch } from '@linkagent/shared';

test('dispatchReplyWithBufferedBlockDispatcher：无 ctx.AgentId 时用 channels.wecom.agentId（非 opencode）', async () => {
  let seenAgentId = '';
  const dispatch: ChannelAgentDispatch = {
    async chat(params, cb) {
      seenAgentId = params.agentId;
      cb.onText('ok');
    },
  };
  await dispatchReplyWithBufferedBlockDispatcher(
    {
      ctx: {
        Body: '你好',
        OriginatingChannel: 'wecom',
        AccountId: 'default',
        From: 'zhangsan',
        ChatType: 'direct',
      },
      cfg: { channels: { wecom: { agentId: 'pi' } } },
      dispatcherOptions: {
        deliver: () => {},
      },
    },
    dispatch,
  );
  assert.equal(seenAgentId, 'pi');
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
