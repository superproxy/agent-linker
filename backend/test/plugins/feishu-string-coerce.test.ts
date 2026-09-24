import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanInChannelIngressLifecycles } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { createChannelIngressMonitor } from 'openclaw/plugin-sdk/channel-outbound';
import {
  asNullableRecord,
  normalizeNullableString,
  readStringValue,
} from 'openclaw/plugin-sdk/string-coerce-runtime';

/** 与 @openclaw/feishu parseFeishuMessageEventPayload 同一组判定。 */
function acceptsFeishuMessageEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as {
    sender?: { sender_id?: unknown };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      chat_type?: unknown;
      message_type?: unknown;
      content?: unknown;
    };
  };
  const sender = event.sender;
  const message = event.message;
  if (!sender || typeof sender !== 'object' || !message || typeof message !== 'object') return false;
  if (!sender.sender_id || typeof sender.sender_id !== 'object') return false;
  const messageId = readStringValue(message.message_id);
  const chatId = readStringValue(message.chat_id);
  const chatType = message.chat_type;
  const messageType = readStringValue(message.message_type);
  const chatOk = chatType === 'group' || chatType === 'topic_group' || chatType === 'private' || chatType === 'p2p';
  return Boolean(messageId && chatId && chatOk && messageType && typeof message.content === 'string');
}

test('飞书文本事件字段按字符串读取，不再被当成畸形 payload', () => {
  assert.equal(readStringValue('om_abc'), 'om_abc');
  assert.equal(readStringValue('  '), undefined);
  assert.equal(normalizeNullableString('im.message.receive_v1'), 'im.message.receive_v1');
  assert.equal(asNullableRecord({ text: '你好' })?.text, '你好');
  assert.equal(
    acceptsFeishuMessageEvent({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"你好"}',
      },
    }),
    true,
  );
});

test('飞书入站生命周期带 abortSignal，合并后仍可读取', async () => {
  let seen: AbortSignal | undefined;
  const monitor = createChannelIngressMonitor({
    async deliver(_raw: unknown, lifecycle: { abortSignal?: AbortSignal }) {
      seen = lifecycle.abortSignal;
    },
  });
  await monitor.admit('{}', { facts: { eventId: 'evt_1' } });
  assert.equal(seen?.aborted, false);
  const merged = fanInChannelIngressLifecycles([{ abortSignal: seen, onAdopted() {} }]);
  assert.equal(merged.lifecycle.abortSignal, seen);
});
