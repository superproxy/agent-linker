/**
 * 微信渠道诊断 2：getUpdates 拉一次，完整打印消息字段（context_token / run_id 是否存在）。
 * 用法: pnpm --filter @linkagent/backend exec tsx src/dev/diag-ilink2.ts
 */
import { getUpdates, loadWeixinAccount } from '../channels/ilink-client.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../gateway/config.js';

const account = loadWeixinAccount(join(findRepoRoot(), '.runtime-state', 'plugins'));
const syncPath = join(
  findRepoRoot(),
  '.runtime-state/plugins/openclaw-weixin/accounts',
  `${account.id}.sync.json`,
);
let buf = '';
try {
  buf = (JSON.parse(readFileSync(syncPath, 'utf8')) as { get_updates_buf?: string }).get_updates_buf ?? '';
} catch {}

console.log('sync buf length:', buf.length);
const r = await getUpdates({ baseUrl: account.baseUrl, token: account.token, getUpdatesBuf: buf, timeoutMs: 8000 });
console.log('ret =', r.ret, 'errcode =', r.errcode, 'errmsg =', r.errmsg ?? '(none)');
console.log('msgs count =', (r.msgs ?? []).length);
for (const m of r.msgs ?? []) {
  console.log('--- msg ---');
  console.log('from_user_id:', m.from_user_id);
  console.log('context_token:', m.context_token ? `${String(m.context_token).slice(0, 40)}...` : 'MISSING/EMPTY');
  console.log('run_id:', m.run_id ?? 'MISSING');
  console.log('message_type:', m.message_type, 'message_state:', m.message_state, 'client_id:', m.client_id);
  console.log('item_list:', JSON.stringify(m.item_list ?? []).slice(0, 200));
  console.log('all keys:', Object.keys(m).join(', '));
}
process.exit(0);
