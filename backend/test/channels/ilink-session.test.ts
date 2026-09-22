import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIlinkSessionExpired, loadLatestWeixinAccount, loadWeixinAccount } from '../../src/channels/ilink-client.js';

test('errcode -14 / session timeout 视为登录态失效', () => {
  assert.equal(isIlinkSessionExpired({ errcode: -14, errmsg: 'session timeout' }), true);
  assert.equal(isIlinkSessionExpired({ errmsg: 'Session Timeout' }), true);
  assert.equal(isIlinkSessionExpired({ errcode: 0, errmsg: '' }), false);
  assert.equal(isIlinkSessionExpired({ errcode: -1, errmsg: 'busy' }), false);
});

function writeAcc(root: string, id: string, token: string, savedAt: string): void {
  const dir = join(root, 'openclaw-weixin', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ token, baseUrl: 'https://ilinkai.weixin.qq.com', userId: id, savedAt }),
  );
}

test('loadLatestWeixinAccount：优先 preferredId，否则取 savedAt 最新', () => {
  const root = mkdtempSync(join(tmpdir(), 'wx-acc-'));
  writeAcc(root, 'old', 'tok-old', '2026-01-01T00:00:00.000Z');
  writeAcc(root, 'local', 'tok-new', '2026-09-21T00:00:00.000Z');
  writeFileSync(join(root, 'openclaw-weixin', 'accounts', 'local.sync.json'), JSON.stringify({ get_updates_buf: 'x' }));
  assert.equal(loadLatestWeixinAccount(root, 'old').token, 'tok-old');
  assert.equal(loadLatestWeixinAccount(root).token, 'tok-new');
  assert.equal(loadLatestWeixinAccount(root).id, 'local');
  assert.equal(loadWeixinAccount(root, 'old').token, 'tok-old');
  assert.throws(() => loadLatestWeixinAccount(root, 'yxz'), /未找到 yxz\.json/);
  assert.throws(() => loadWeixinAccount(root, 'yxz'), /找不到 yxz\.json/);
});
