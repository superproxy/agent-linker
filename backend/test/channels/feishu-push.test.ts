import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEISHU_ELEMENT_ID,
  FEISHU_STREAM_ELEMENT_LIMIT,
  FeishuTextStream,
  isFeishuStatusChunk,
  streamingCardData,
  type FeishuCardApi,
} from '../../src/channels/feishu-push.js';

interface Call {
  op: string;
  cardId?: string;
  content?: string;
  sequence?: number;
}

function fakeApi(failCreate = false): { api: FeishuCardApi; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const api: FeishuCardApi = {
    async createCard(cardJson) {
      if (failCreate) throw new Error('create failed');
      calls.push({ op: 'create', content: cardJson });
      n += 1;
      return `card-${n}`;
    },
    async replyCard(_messageId, cardId) {
      calls.push({ op: 'reply', cardId });
    },
    async updateContent(cardId, elementId, content, sequence) {
      assert.equal(elementId, FEISHU_ELEMENT_ID);
      calls.push({ op: 'content', cardId, content, sequence });
    },
    async closeStream(cardId, sequence) {
      calls.push({ op: 'close', cardId, sequence });
    },
  };
  return { api, calls };
}

test('流式卡片：首包立刻回复，间隔内不刷，结束时收口', async () => {
  let now = 1_000;
  const { api, calls } = fakeApi();
  const stream = new FeishuTextStream(api, 'om_1', () => now, 400);
  await stream.push('你');
  assert.equal(stream.started, true);
  assert.match(calls[0]?.content ?? '', /"streaming_mode":true/);
  assert.equal(JSON.parse(streamingCardData('你')).body.elements[0].content, '你');
  assert.equal(calls[1]?.op, 'reply');

  now = 1_100;
  await stream.push('你好');
  assert.equal(calls.filter((call) => call.op === 'content').length, 0);

  now = 1_600;
  await stream.push('你好呀');
  const update = calls.find((call) => call.op === 'content');
  assert.equal(update?.content, '你好呀');
  assert.equal(update?.sequence, 1);

  await stream.finish('你好呀。');
  const contents = calls.filter((call) => call.op === 'content');
  assert.equal(contents[contents.length - 1]?.content, '你好呀。');
  const close = calls.find((call) => call.op === 'close');
  assert.equal(close?.sequence, 3);
  assert.equal(close?.cardId, 'card-1');
});

test('创建卡片失败时不回复，调用方改走文本', async () => {
  const { api, calls } = fakeApi(true);
  const stream = new FeishuTextStream(api, 'om_1', () => 0, 0);
  await assert.rejects(() => stream.push('你好'), /create failed/);
  assert.equal(stream.failed, true);
  assert.equal(stream.started, false);
  assert.equal(calls.some((call) => call.op === 'reply'), false);
  await stream.finish('你好');
  assert.equal(calls.some((call) => call.op === 'close'), false);
});

test('超过单卡上限后另开一张', async () => {
  const { api, calls } = fakeApi();
  const stream = new FeishuTextStream(api, 'om_1', () => 0, 0);
  const text = `${'a'.repeat(FEISHU_STREAM_ELEMENT_LIMIT)}尾`;
  await stream.push(text);
  await stream.finish(text);
  const closes = calls.filter((call) => call.op === 'close');
  assert.equal(closes.length, 2);
  assert.equal(closes[0]?.cardId, 'card-1');
  assert.equal(closes[1]?.cardId, 'card-2');
  const created = calls.filter((call) => call.op === 'create');
  assert.match(created[1]?.content ?? '', /尾/);
});

test('状态摘要不进流式卡片', () => {
  assert.equal(isFeishuStatusChunk('🤔 想一下'), true);
  assert.equal(isFeishuStatusChunk('⚠️ 处理失败'), true);
  assert.equal(isFeishuStatusChunk('正文'), false);
});
