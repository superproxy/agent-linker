import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageItemType, extractText } from '../../src/channels/ilink-client.js';

function item(type: number, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

test('extractText 纯文本消息拼接（与旧行为一致）', () => {
  const msg = {
    from_user_id: 'u1',
    item_list: [
      item(MessageItemType.TEXT, { text_item: { text: '你好' } }),
      item(MessageItemType.TEXT, { text_item: { text: '世界' } }),
    ],
  };
  assert.equal(extractText(msg), '你好世界');
});

test('extractText 语音消息用服务端转写文本', () => {
  const msg = {
    from_user_id: 'u1',
    item_list: [item(MessageItemType.VOICE, { voice_item: { text: ' 在吗 ' } })],
  };
  assert.equal(extractText(msg), '[语音转写: 在吗]');
});

test('extractText 语音消息无转写时降级占位', () => {
  const msg = {
    from_user_id: 'u1',
    item_list: [item(MessageItemType.VOICE, { voice_item: {} })],
  };
  assert.equal(extractText(msg), '[语音消息]');
});

test('extractText 表情/图片消息占位，与文字共存', () => {
  const msg = {
    from_user_id: 'u1',
    item_list: [
      item(MessageItemType.IMAGE),
      item(MessageItemType.TEXT, { text_item: { text: '哈哈' } }),
    ],
  };
  assert.equal(extractText(msg), '[图片]哈哈');
});

test('extractText 文件/视频占位', () => {
  const msg = {
    from_user_id: 'u1',
    item_list: [item(MessageItemType.FILE), item(MessageItemType.VIDEO)],
  };
  assert.equal(extractText(msg), '[文件][视频]');
});

test('extractText 空消息返回空串', () => {
  assert.equal(extractText({ from_user_id: 'u1', item_list: [] }), '');
  assert.equal(extractText({ from_user_id: 'u1' }), '');
});
