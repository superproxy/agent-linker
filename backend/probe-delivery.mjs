// 决定性送达探针：同一账号、同一目标用户，三种 sendMessage 请求变体各发一条，
// 日志写文件（/tmp/probe-delivery.log），用于判定腾讯静默丢弃是「请求形态」还是「账号级」。
// 不轮询 getUpdates、不碰运行中网关。
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const LOG = '/tmp/probe-delivery.log';
const log = (line) => {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  appendFileSync(LOG, s + '\n');
};

const REPO = '/Users/yangxuezeng/CodeBuddy/linkagent';
const acc = JSON.parse(readFileSync(`${REPO}/.runtime-state/plugins/openclaw-weixin/accounts/47c8d8907f3e-im-bot.json`, 'utf8'));
const ctxStore = JSON.parse(readFileSync(`${REPO}/.runtime-state/plugins/openclaw-weixin/accounts/47c8d8907f3e-im-bot.context-tokens.json`, 'utf8'));
const to = 'o9cq806l8TCt_qAKvyMjvJa5yq7k@im.wechat';
const contextToken = ctxStore[to];

log(`START to=${to} tokenLen=${acc.token?.length} contextToken=${contextToken ? 'present(len=' + contextToken.length + ')' : 'MISSING'}`);

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}
function pluginClientId() {
  return `openclaw-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`;
}
function linkagentClientId() {
  return `linkagent-${randomBytes(8).toString('hex')}`;
}

const headers = (token) => ({
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  Authorization: `Bearer ${token.trim()}`,
  'X-WECHAT-UIN': randomWechatUin(),
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String(0x020408),
});

async function send(label, { clientId, botAgent, runId, token, ctxToken }) {
  const msg = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: label } }],
    ...(ctxToken ? { context_token: ctxToken } : {}),
    ...(runId ? { run_id: runId } : {}),
  };
  const body = { msg, base_info: { channel_version: '2.4.8', bot_agent: botAgent } };
  const reqLog = JSON.stringify({ clientId: clientId.slice(0, 40), botAgent, hasRunId: !!runId, hasCtx: !!ctxToken });
  log(`SEND ${label} ${reqLog}`);
  try {
    const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage', {
      method: 'POST', headers: headers(token), body: JSON.stringify(body),
    });
    const raw = await res.text();
    log(`RESP ${label} HTTP=${res.status} body=${raw.slice(0, 300)}`);
    return { http: res.status, raw };
  } catch (err) {
    log(`ERR ${label} ${String(err)}`);
    return { http: 0, raw: String(err) };
  }
}

// 变体 A：插件原样（client_id=openclaw-weixin:*, bot_agent=OpenClaw, 带 run_id + context_token）
await send('【P-A 插件原样】链路测试A', {
  clientId: pluginClientId(), botAgent: 'OpenClaw',
  runId: randomBytes(16).toString('hex'), token: acc.token, ctxToken: contextToken,
});

// 变体 B：当前网关实现（client_id=linkagent-*, bot_agent=linkagent-bot/0.1.0, 带 run_id + context_token）
await send('【P-B 当前实现】链路测试B', {
  clientId: linkagentClientId(), botAgent: 'linkagent-bot/0.1.0',
  runId: randomBytes(16).toString('hex'), token: acc.token, ctxToken: contextToken,
});

// 变体 C：无 context_token 无 run_id（隔离 token/run_id 影响），插件形态 client_id
await send('【P-C 无token无runid】链路测试C', {
  clientId: pluginClientId(), botAgent: 'OpenClaw',
  runId: undefined, token: acc.token, ctxToken: undefined,
});

// getConfig 诊断：拿 typing_ticket，看服务端对当前登录态/用户的会话判定
log('--- getconfig ---');
try {
  const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/getconfig', {
    method: 'POST',
    headers: headers(acc.token),
    body: JSON.stringify({ ilink_user_id: to, context_token: contextToken ?? '', base_info: { channel_version: '2.4.8', bot_agent: 'OpenClaw' } }),
  });
  const raw = await res.text();
  log(`GETCONFIG HTTP=${res.status} body=${raw.slice(0, 500)}`);
} catch (err) {
  log(`GETCONFIG ERR ${String(err)}`);
}

log('DONE');
