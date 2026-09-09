/**
 * 微信渠道临时诊断：直接调 ilink API 测 getUpdates / sendText。
 * 用法: pnpm --filter @linkagent/backend exec tsx src/dev/diag-ilink.ts
 */
import { getUpdates, sendText, loadWeixinAccount } from '../channels/ilink-client.js';
import { join } from 'node:path';
import { findRepoRoot } from '../gateway/config.js';

const account = loadWeixinAccount(join(findRepoRoot(), '.runtime-state', 'plugins'));

// 1) getUpdates 短超时（3s）——看服务端是否正常返回
console.log('=== getUpdates (3s 短轮询) ===');
try {
  const r = await getUpdates({ baseUrl: account.baseUrl, token: account.token, timeoutMs: 3000 });
  console.log('ret =', r.ret, ' errcode =', r.errcode, ' errmsg =', r.errmsg ?? '(none)');
  console.log('msgs =', JSON.stringify(r.msgs ?? []).slice(0, 500));
  console.log('get_updates_buf =', (r.get_updates_buf ?? '').slice(0, 80));
} catch (err) {
  console.log('getUpdates 异常:', err instanceof Error ? err.message : err);
}

// 2) sendText 主动推一条测试消息给 bot 自己的 userId
console.log('\n=== sendText 测试 ===');
try {
  const res = await sendText({
    baseUrl: account.baseUrl,
    token: account.token,
    to: account.userId,
    text: '【诊断】链路测试：如果你看到这条消息，说明 sendText 回推正常。',
  });
  console.log('sendText OK, messageId =', res.messageId);
} catch (err) {
  console.log('sendText 失败:', err instanceof Error ? err.message : err);
}

process.exit(0);
