/**
 * openclaw 插件运行时冒烟测试（dev 工具）：
 *   1. dynamic import @wecom/wecom-openclaw-plugin（验证 openclaw shim 解析）
 *   2. plugin.register(api)（验证 ChannelPlugin / HTTP 路由 / tool 注册）
 *   3. 构造真实 PluginRuntime，调 dispatchReplyWithBufferedBlockDispatcher
 *      （验证 core.channel.* 语义与流式 deliver）
 * 不连真实企业微信；agent 用 stub（echo）。
 *
 * 运行：pnpm --filter @linkagent/backend smoke-plugin
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginRuntime, type RuntimeLogger } from '../gateway/plugins/runtime/core.js';
import { createPluginApi, type PluginApiCollector } from '../gateway/plugins/runtime/api.js';
import type { ChannelPluginHandle } from '../gateway/plugins/manager.js';
import type { ChannelAgentDispatch } from '../gateway/plugins/runtime/channel/reply.js';
import { resolveAgentRoute, buildAgentSessionKey } from '../gateway/plugins/runtime/channel/routing.js';
import { chunkText } from '../gateway/plugins/runtime/channel/text.js';
import { resolveCommandAuthorizedFromAuthorizers } from '../gateway/plugins/runtime/channel/commands.js';

const log: RuntimeLogger = {
  debug: (m) => console.log(`  [debug] ${m}`),
  info: (m) => console.log(`  [info ] ${m}`),
  warn: (m) => console.log(`  [warn ] ${m}`),
  error: (m, ...a) => console.log(`  [error] ${m}`, ...a),
};

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const stateDir = mkdtempSync(join(tmpdir(), 'linkagent-plugin-smoke-'));

async function main(): Promise<void> {
  console.log('== 1. 加载插件包（openclaw shim 解析） ==');
  const mod = (await import('@wecom/wecom-openclaw-plugin')) as { default?: unknown };
  const plugin = mod.default as {
    id?: string;
    name?: string;
    register(api: unknown): void;
  };
  check('插件 default export 存在', typeof plugin === 'object' && plugin !== null);
  check('插件 id 为 wecom-openclaw-plugin', plugin.id === 'wecom-openclaw-plugin', plugin.id);

  console.log('== 2. register(api) 注册面 ==');
  const collector: PluginApiCollector = { channels: new Map(), httpRoutes: [], tools: [], hooks: [] };
  const cfg: Record<string, unknown> = {
    channels: { wecom: { enabled: true, botId: 'smoke-bot', secret: 'smoke-secret', connectionMode: 'webhook' } },
    tools: { allow: [], deny: [] },
  };
  const dispatch: ChannelAgentDispatch = {
    async chat({ text }, cb) {
      for (const line of text.split(/(?<=[。\n])/)) {
        cb.onText(`[echo] ${line}`);
      }
    },
  };
  const runtime = createPluginRuntime({ stateDir, config: cfg, logger: log, agentDispatch: dispatch });
  const api = createPluginApi({
    pluginId: plugin.id ?? 'wecom',
    name: (plugin as { name?: string }).name ?? 'wecom',
    version: '0.0.0',
    config: cfg,
    runtime,
    logger: log,
    collector,
  });
  plugin.register(api);
  check('注册 1 个 channel（wecom）', collector.channels.size === 1, String(collector.channels.size));
  check('注册 5 条 HTTP 路由', collector.httpRoutes.length === 5, String(collector.httpRoutes.length));
  check('注册 1 个 tool（wecom-cli）', collector.tools.length === 1, String(collector.tools.length));
  check('注册 before_prompt_build hook', collector.hooks.some((h) => h.event === 'before_prompt_build'));
  const paths = collector.httpRoutes.map((r) => r.path).sort();
  check(
    '路由路径正确',
    JSON.stringify(paths) ===
      JSON.stringify(['/plugins/wecom/agent', '/plugins/wecom/bot', '/wecom', '/wecom/agent', '/wecom/bot'].sort()),
    JSON.stringify(paths),
  );

  console.log('== 3. channel 插件配置接口 ==');
  const entry = collector.channels.get('wecom');
  const channelPlugin = (entry as unknown as { plugin: { config: Record<string, unknown>; gateway: Record<string, unknown> } }).plugin;
  const configApi = channelPlugin.config as {
    listAccountIds(c: Record<string, unknown>): string[];
    resolveAccount(c: Record<string, unknown>, id: string): { enabled?: boolean };
    defaultAccountId(c: Record<string, unknown>): string;
    isConfigured(a: Record<string, unknown>): boolean;
  };
  const ids = configApi.listAccountIds(cfg);
  check('listAccountIds → [default]', JSON.stringify(ids) === JSON.stringify(['default']), JSON.stringify(ids));
  const account = configApi.resolveAccount(cfg, 'default');
  check('resolveAccount 读顶层 botId', (account as { botId?: string }).botId === 'smoke-bot');
  check('isConfigured(botId+secret) → true', configApi.isConfigured(account));
  check('gateway.startAccount 存在', typeof channelPlugin.gateway.startAccount === 'function');

  console.log('== 4. core.channel.routing（会话隔离） ==');
  const route = resolveAgentRoute({
    cfg,
    channel: 'wecom',
    accountId: 'default',
    peer: { kind: 'direct', id: 'zhangsan' },
  });
  check('agentId 缺省 opencode', route.agentId === 'opencode', route.agentId);
  check(
    'DM 会话 key 含用户维度（多轮不串人）',
    route.sessionKey === 'agent:opencode:wecom:default:direct:zhangsan',
    route.sessionKey,
  );
  const route2 = resolveAgentRoute({ cfg, channel: 'wecom', accountId: 'default', peer: { kind: 'direct', id: 'lisi' } });
  check('不同用户不同会话', route2.sessionKey !== route.sessionKey);
  const groupRoute = resolveAgentRoute({ cfg, channel: 'wecom', accountId: 'default', peer: { kind: 'group', id: 'chatid1' } });
  check(
    '群会话 key 按群隔离',
    groupRoute.sessionKey === 'agent:opencode:wecom:group:chatid1',
    groupRoute.sessionKey,
  );
  check(
    'buildAgentSessionKey 直接可用',
    buildAgentSessionKey({ agentId: 'opencode', channel: 'wecom', accountId: 'default', peerKind: 'direct', peerId: 'a' }) ===
      'agent:opencode:wecom:default:direct:a',
  );

  console.log('== 5. core.channel.text / commands ==');
  const chunks = chunkText('第一段\n第二段 ' + 'x'.repeat(100) + '\n第三段', 40);
  check('chunkText 多块', chunks.length >= 3, String(chunks.length));
  check('chunkText 每块 ≤ 41', chunks.every((c) => c.length <= 41));
  check('command 检测 /reset', resolveCommandAuthorizedFromAuthorizers({ useAccessGroups: false, authorizers: [] }) === true);
  check(
    '命令鉴权（accessGroups off + deny）',
    resolveCommandAuthorizedFromAuthorizers({ useAccessGroups: false, authorizers: [{ configured: true, allowed: false }], modeWhenAccessGroupsOff: 'deny' }) === false,
  );

  console.log('== 6. dispatch → deliver 流式 ==');
  const delivered: string[] = [];
  const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: '你好，请介绍一下你自己。',
      SessionKey: route.sessionKey,
      AccountId: 'default',
      AgentId: 'opencode',
    },
    cfg,
    dispatcherOptions: {
      deliver: (payload: { text: string }) => {
        delivered.push(payload.text);
      },
      onError: (err: unknown) => console.error('  dispatch onError:', err),
    },
  });
  check('dispatch 完成', result.delivered === true);
  check('deliver 收到内容', delivered.length > 0, `blocks=${delivered.length}`);
  check('deliver 内容包含 echo', delivered.join('').includes('[echo]'));

  console.log('== 7. 微信插件（openclaw-weixin）shim 解析 + 注册 ==');
  const weixinMod = (await import('@tencent-weixin/openclaw-weixin/dist/index.js')) as { default?: unknown };
  const weixinPlugin = weixinMod.default as {
    id?: string;
    name?: string;
    register(api: unknown): void;
  };
  check('微信插件 default export 存在', typeof weixinPlugin === 'object' && weixinPlugin !== null);
  check('微信插件 id 为 openclaw-weixin', weixinPlugin.id === 'openclaw-weixin', weixinPlugin.id);

  const wxCfg: Record<string, unknown> = {
    channels: { 'openclaw-weixin': {} },
    tools: { allow: [], deny: [] },
  };
  const wxCtx: PluginApiCollector = { channels: new Map(), httpRoutes: [], tools: [], hooks: [] };
  const wxRuntime = createPluginRuntime({ stateDir, config: wxCfg, logger: log, agentDispatch: dispatch });
  const wxApi = createPluginApi({
    pluginId: weixinPlugin.id ?? 'weixin',
    name: (weixinPlugin as { name?: string }).name ?? 'weixin',
    version: '0.0.0',
    config: wxCfg,
    runtime: wxRuntime,
    logger: log,
    collector: wxCtx,
  });
  weixinPlugin.register(wxApi);
  check('微信插件注册 1 个 channel', wxCtx.channels.size === 1, String(wxCtx.channels.size));
  check('微信插件未注册 HTTP 路由（登录后才走长轮询）', wxCtx.httpRoutes.length === 0, String(wxCtx.httpRoutes.length));
  const wxEntry = wxCtx.channels.get('openclaw-weixin');
  const wxChannel = (wxEntry as unknown as { plugin: ChannelPluginHandle }).plugin;
  check('微信插件 config 接口齐全',
    typeof wxChannel.config.listAccountIds === 'function' &&
      typeof wxChannel.config.resolveAccount === 'function' &&
      typeof wxChannel.config.isConfigured === 'function');
  check('微信插件 gateway.loginWithQrStart 存在',
    typeof (wxChannel.gateway as unknown as { loginWithQrStart?: unknown }).loginWithQrStart === 'function');
  check('微信插件 gateway.loginWithQrWait 存在',
    typeof (wxChannel.gateway as unknown as { loginWithQrWait?: unknown }).loginWithQrWait === 'function');
  check('微信插件 gateway.startAccount 存在', typeof wxChannel.gateway.startAccount === 'function');
  const wxAccount = wxChannel.config.resolveAccount(wxCfg, 'default') ?? {};
  check('未登录时 isConfigured=false', wxChannel.config.isConfigured(wxAccount) === false);

  console.log(`\n冒烟结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('冒烟失败:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
