/**
 * 微信通道捕获探针（临时诊断用）：
 * 与 weixin-bot 的 monitor 并发长轮询，抓取下一条微信入站消息：
 *   1. 完整 dump 原始消息 JSON（确认 context_token / run_id 等字段是否存在及路径）；
 *   2. 用「与 bot 完全相同的 sendText（msg.context_token，无 run_id）」回推一条测试消息；
 *   3. 再用「+run_id」回推一条，对比腾讯是否丢弃。
 * 结果写入 <repo>/.runtime-state/weixin-capture.log。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUpdates, loadWeixinAccount, sendText, extractText, type WeixinInboundMessage } from '../channels/ilink-client.js';

const REPO_ROOT = '/Users/yangxuezeng/CodeBuddy/linkagent';
const stateDir = join(REPO_ROOT, '.runtime-state', 'plugins');
const outFile = join(REPO_ROOT, '.runtime-state', 'weixin-capture.log');
const account = loadWeixinAccount(stateDir);
const to = 'o9cq806l8TCt_qAKvyMjvJa5yq7k@im.wechat';
const WINDOW_MS = 6 * 60_000;
const POLL_MS = 35_000;

const log = (s: string) => appendFileSync(outFile, `${new Date().toISOString()} ${s}\n`);

let buf = '';
try {
  const sync = JSON.parse(readFileSync(join(stateDir, 'openclaw-weixin/accounts', `${account.id}.sync.json`), 'utf8')) as { get_updates_buf?: string };
  buf = sync.get_updates_buf ?? '';
} catch {
  /* 无游标，从空开始 */
}
log(`START account=${account.id} to=${to} bufLen=${buf.length} window=${WINDOW_MS}ms`);

const deadline = Date.now() + WINDOW_MS;
let tested = false;

while (Date.now() < deadline) {
  let resp: Awaited<ReturnType<typeof getUpdates>>;
  try {
    resp = await getUpdates({ baseUrl: account.baseUrl, token: account.token, getUpdatesBuf: buf, timeoutMs: POLL_MS });
  } catch (err) {
    log(`POLL-ERR ${err instanceof Error ? err.message : String(err)}`);
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  if (resp.get_updates_buf) buf = resp.get_updates_buf;
  const msgs = (resp.msgs ?? []) as WeixinInboundMessage[];
  for (const m of msgs) {
    log(`CAPTURED ${JSON.stringify(m)}`);
    const text = extractText(m);
    const ctx = m.context_token;
    log(`  -> text="${text.slice(0, 120)}" context_token=${ctx ? `present(${ctx.slice(0, 30)}…,len=${ctx.length})` : 'ABSENT'} run_id=${m.run_id ?? 'ABSENT'} message_type=${m.message_type} message_state=${m.message_state}`);
    if (tested) continue;
    tested = true;
    // 1) 与 weixin-bot 完全一致的发送（msg.context_token、无 run_id）
    try {
      const r1 = await sendText({ baseUrl: account.baseUrl, token: account.token, to, text: '【捕获·同bot路径】收到你的消息（无run_id）', contextToken: ctx });
      log(`SEND-botPath OK id=${r1.messageId}`);
    } catch (err) {
      log(`SEND-botPath FAIL ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2) 加 run_id
    try {
      const r2 = await sendText({ baseUrl: account.baseUrl, token: account.token, to, text: '【捕获·+run_id】收到你的消息', contextToken: ctx, runId: randomUUID() });
      log(`SEND-withRunId OK id=${r2.messageId}`);
    } catch (err) {
      log(`SEND-withRunId FAIL ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
log('EXIT (window elapsed, no more polls)');
