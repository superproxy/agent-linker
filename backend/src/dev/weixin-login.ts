/**
 * 个人微信扫码登录（dev 工具）
 *
 * 流程（对齐 openclaw-weixin 插件的官方扫码机制，经 ilink 官方长轮询 API，无封号风险）：
 *   1. 设 OPENCLAW_STATE_DIR（<repo>/.runtime-state/plugins，与 gateway 一致）
 *   2. import @tencent-weixin/openclaw-weixin，模拟 register() 提取 openclaw-weixin channel 插件
 *   3. loginWithQrStart() → 拿 qrcode_img_content（二维码图片 URL）
 *   4. 终端渲染二维码（qrcode-terminal）→ 手机微信「扫一扫」
 *   5. loginWithQrWait() 长轮询 get_qrcode_status 直到 confirmed
 *   6. 插件自动把 bot_token + ilink_bot_id 写入 accounts.json + accounts/<id>.json
 *      （重启 gateway 后 isConfigured=true，monitor 自动长轮询 getUpdates 收消息）
 *
 * 运行：pnpm --filter @linkagent/backend weixin-login
 */
import { join } from 'node:path';
import { findRepoRoot } from '../gateway/config.js';

interface LoginGatewayHandle {
  loginWithQrStart(params: { accountId?: string; force?: boolean; verbose?: boolean }): Promise<{
    qrDataUrl?: string;
    message?: string;
    sessionKey?: string;
  }>;
  loginWithQrWait(params: { sessionKey?: string; accountId?: string; timeoutMs?: number }): Promise<{
    connected?: boolean;
    message?: string;
    accountId?: string;
  }>;
}

interface WeixinChannelPlugin {
  id?: string;
  gateway: LoginGatewayHandle;
}

const stateDir = join(findRepoRoot(), '.runtime-state', 'plugins');
process.env.OPENCLAW_STATE_DIR = stateDir;

async function main(): Promise<void> {
  console.log(`[weixin-login] OPENCLAW_STATE_DIR=${stateDir}`);

  // 1. 加载微信插件（无 exports/main，需指向 dist/index.js）
  const mod = (await import('@tencent-weixin/openclaw-weixin/dist/index.js')) as { default?: unknown };
  const plugin = mod.default as { id?: string; name?: string; register(api: unknown): void };
  if (!plugin || typeof plugin.register !== 'function') {
    throw new Error('openclaw-weixin 插件无 register() 入口');
  }

  // 2. 模拟 register() 提取 channel 插件对象（只关心 gateway.loginWithQr*）
  let weixinChannel: WeixinChannelPlugin | null = null;
  const stubApi: {
    version: string;
    registerChannel(registration: { plugin?: WeixinChannelPlugin; id?: string }): void;
    registerHttpRoute(): void;
    registerTool(): void;
    on(): void;
    config: Record<string, unknown>;
    logger: { debug(): void; info(): void; warn(): void; error(): void };
    runtime: { version: string; channel: Record<string, unknown> };
  } = {
    version: '2026.9.3-linkagent',
    registerChannel(registration) {
      const p = registration.plugin ?? (registration as unknown as WeixinChannelPlugin);
      if (p && typeof p.gateway?.loginWithQrStart === 'function') weixinChannel = p;
    },
    registerHttpRoute() {},
    registerTool() {},
    on() {},
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtime: { version: '2026.9.3-linkagent', channel: {} },
  };
  plugin.register(stubApi);
  if (!weixinChannel) throw new Error('未提取到 openclaw-weixin channel 插件（registerChannel 未回调）');
  const handle: WeixinChannelPlugin = weixinChannel;

  // 3. 发起扫码登录
  console.log('[weixin-login] 正在向 ilink 申请登录二维码...');
  const start = await handle.gateway.loginWithQrStart({ force: true, verbose: true });
  if (!start.qrDataUrl) {
    throw new Error(`获取二维码失败：${start.message ?? '未知错误'}`);
  }
  console.log(`\n[weixin-login] ${start.message ?? '请用手机微信扫码'}\n`);

  // 4. 终端渲染二维码（失败则打印链接，浏览器打开后手机扫码）
  try {
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(start.qrDataUrl, { small: true });
  } catch {
    console.log(`二维码图片链接（浏览器打开后用手机微信扫码）：\n${start.qrDataUrl}\n`);
  }

  // 5. 长轮询等待确认（最长 8 分钟，过期自动刷新）
  console.log('[weixin-login] 等待手机扫码确认（最长 8 分钟，二维码过期会自动刷新）...');
  const wait = await handle.gateway.loginWithQrWait({ sessionKey: start.sessionKey, timeoutMs: 480_000 });
  if (wait.connected) {
    console.log(`\n✅ 登录成功：账号 ${wait.accountId} 已保存到 ${stateDir}/openclaw-weixin/`);
    console.log('重启 gateway（pnpm --filter @linkagent/backend dev）后即自动开始收消息。');
  } else {
    console.log(`\n❌ 登录未完成：${wait.message ?? '未知原因'}`);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error('[weixin-login] 失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
