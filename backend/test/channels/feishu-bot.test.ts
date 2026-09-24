import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feishuTextFromContent } from '../../src/channels/feishu-bot.js';

test('飞书文本消息从 content JSON 取出正文', () => {
  assert.equal(feishuTextFromContent('text', '{"text":" 你好 "}'), '你好');
  assert.equal(feishuTextFromContent('text', 'not-json'), '');
  assert.equal(feishuTextFromContent('image', '{"text":"你好"}'), '');
});
