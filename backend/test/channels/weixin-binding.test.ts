import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimWeixinBinding,
  loadBoundWeixinAccount,
  normalizeBotAccountId,
  readWeixinBinding,
  removeWeixinBinding,
} from '../../src/channels/weixin-binding.js';

test('normalizeBotAccountId：@im.bot → -im-bot', () => {
  assert.equal(normalizeBotAccountId('89b53341f048@im.bot'), '89b53341f048-im-bot');
});

test('claimWeixinBinding：只写绑定，不复制 admin.json', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-wx-bind-'));
  const dir = join(stateDir, 'openclaw-weixin', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '89b53341f048-im-bot.json'),
    JSON.stringify({ token: 'tok-a', userId: 'wx_a', savedAt: '2026-09-22T00:00:00.000Z' }),
  );
  assert.equal(claimWeixinBinding(stateDir, 'admin', '89b53341f048@im.bot'), 'ok');
  assert.equal(existsSync(join(dir, 'admin.json')), false);
  const binding = readWeixinBinding(stateDir, 'admin');
  assert.equal(binding?.botAccountId, '89b53341f048-im-bot');
  const acc = loadBoundWeixinAccount(stateDir, 'admin');
  assert.equal(acc.id, '89b53341f048-im-bot');
  assert.equal(acc.token, 'tok-a');
});

test('claimWeixinBinding：同一机器人不能绑两个登录用户', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-wx-bind2-'));
  const dir = join(stateDir, 'openclaw-weixin', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bot-im-bot.json'), JSON.stringify({ token: 't', savedAt: '2026-01-01' }));
  assert.equal(claimWeixinBinding(stateDir, 'alice', 'bot-im-bot'), 'ok');
  assert.equal(claimWeixinBinding(stateDir, 'bob', 'bot-im-bot'), 'taken');
  assert.equal(readWeixinBinding(stateDir, 'bob'), null);
});

test('loadBoundWeixinAccount：未绑定直接失败', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-wx-bind3-'));
  assert.throws(() => loadBoundWeixinAccount(stateDir, 'admin'), /未绑定微信/);
});

test('removeWeixinBinding：去掉指向，保留 *-im-bot.json', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-wx-bind4-'));
  const dir = join(stateDir, 'openclaw-weixin', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x-im-bot.json'), JSON.stringify({ token: 't', savedAt: '2026-01-01' }));
  claimWeixinBinding(stateDir, 'admin', 'x-im-bot');
  removeWeixinBinding(stateDir, 'admin');
  assert.equal(readWeixinBinding(stateDir, 'admin'), null);
  assert.equal(JSON.parse(readFileSync(join(dir, 'x-im-bot.json'), 'utf8')).token, 't');
});
