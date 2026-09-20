import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageItemType, encryptAesEcb, extractText, sendImage } from '../../src/channels/ilink-client.js';
import { createDecipheriv } from 'node:crypto';

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

test('encryptAesEcb 可被同 key 解密还原，且按 16 字节 PKCS7 对齐', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8');
  const plain = Buffer.from('hello 客厅', 'utf8');
  const cipher = encryptAesEcb(plain, key);
  assert.equal(cipher.length % 16, 0);
  assert.ok(cipher.length >= plain.length);
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  const back = Buffer.concat([decipher.update(cipher), decipher.final()]);
  assert.deepEqual(back, plain);
});

test('sendImage 依次走 getuploadurl → CDN 上传 → sendmessage(image_item)', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: { body?: unknown } }> = [];
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]); // 6 字节假 JPEG
  globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, init });
    if (url.includes('/ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({ ret: 0, upload_param: 'UP_PARAM' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/c2c/upload')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ENC_PARAM' } });
    }
    if (url.includes('/ilink/bot/sendmessage')) {
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`未预期的 URL: ${url}`);
  }) as typeof fetch;
  try {
    const res = await sendImage({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'tok',
      to: 'u1@im.wechat',
      image,
      contextToken: 'CT',
    });
    assert.match(res.messageId, /^linkagent-/);
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /getuploadurl/);
    assert.match(calls[1].url, /c2c\/upload\?encrypted_query_param=UP_PARAM/);
    // sendmessage body 含 IMAGE item + media 凭据
    const sendBody = JSON.parse(String(calls[2].init?.body)) as {
      msg: { context_token: string; item_list: Array<{ type: number; image_item: { media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }; mid_size: number } }> };
    };
    assert.equal(sendBody.msg.item_list[0].type, MessageItemType.IMAGE);
    assert.equal(sendBody.msg.item_list[0].image_item.media.encrypt_query_param, 'ENC_PARAM');
    assert.equal(sendBody.msg.item_list[0].image_item.media.encrypt_type, 1);
    assert.equal(sendBody.msg.context_token, 'CT');
    // aes_key 为 base64(32 字符 hex)
    const aesKeyHex = Buffer.from(sendBody.msg.item_list[0].image_item.media.aes_key, 'base64').toString('utf8');
    assert.match(aesKeyHex, /^[0-9a-f]{32}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendImage getuploadurl 失败时抛错且不继续上传', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ ret: 500, errmsg: 'boom' }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      sendImage({ baseUrl: 'https://ilinkai.weixin.qq.com', token: 'tok', to: 'u1@im.wechat', image: Buffer.from('x') }),
      /getuploadurl ret=500.*boom/,
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
