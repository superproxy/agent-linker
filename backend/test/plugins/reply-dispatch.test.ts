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
