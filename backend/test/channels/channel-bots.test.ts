import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feishuTextFromContent } from '../../src/channels/feishu-bot.js';
import { wecomPeerId } from '../../src/channels/wecom-aibot.js';

test('飞书文本 content 只接受 text 类型的 JSON text 字段', () => {
  assert.equal(feishuTextFromContent('text', '{"text":"你好"}'), '你好');
  assert.equal(feishuTextFromContent('text', '{"text":"  hi  "}'), 'hi');
  assert.equal(feishuTextFromContent('post', '{"text":"你好"}'), '');
  assert.equal(feishuTextFromContent('text', 'not-json'), '');
});

test('企微群聊会话用 chatid，单聊用 userid', () => {
  assert.equal(wecomPeerId({ chattype: 'group', chatid: 'wr1', from: { userid: 'u1' } }), 'wr1');
  assert.equal(wecomPeerId({ chattype: 'single', from: { userid: 'u1' } }), 'u1');
  assert.equal(wecomPeerId({ from: {} }), '');
});
