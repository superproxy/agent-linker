/**
 * 登录用户 ↔ 微信机器人的绑定。
 *
 * 插件 @tencent-weixin/openclaw-weixin 自己把登录态写成
 * accounts/<ilink_bot_id>.json（如 89b53341f048-im-bot.json）。这里不改插件、不复制那份文件。
 * 绑定只记录「登录用户名 → 机器人文件 id」。一个登录用户一份绑定、一个机器人只属于一个登录用户。
 * channels 进程按 weixin.accounts 拉起各账号 bot，用这份绑定去读对应的机器人文件。
 */
import { createKvJsonStore } from '../store/kv.js';
import { loadWeixinAccount, type WeixinAccount } from './ilink-client.js';
import { join } from 'node:path';

export interface WeixinUserBinding {
  username: string;
  botAccountId: string;
  boundAt: string;
}

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;

/** 插件回传的 ilink_bot_id 常带 @im.bot，文件名是把这段换成 -im-bot。 */
export function normalizeBotAccountId(raw: string): string {
  let id = raw.trim();
  if (id.endsWith('@im.bot')) id = `${id.slice(0, -'@im.bot'.length)}-im-bot`;
  else id = id.replace(/@/g, '-');
  return id;
}

export function assertWeixinUsername(accountId: string): string {
  const id = accountId.trim();
  if (!USER_ID_RE.test(id)) throw new Error(`非法微信账号槽: ${accountId}`);
  return id;
}

function bindingsStore(stateDir: string) {
  return createKvJsonStore<WeixinUserBinding>(join(stateDir, 'openclaw-weixin', 'bindings'));
}

export function listWeixinBindings(stateDir: string): WeixinUserBinding[] {
  return bindingsStore(stateDir)
    .list()
    .filter((b) => USER_ID_RE.test(b.username) && USER_ID_RE.test(b.botAccountId));
}

export function readWeixinBinding(stateDir: string, username: string): WeixinUserBinding | null {
  const id = username.trim();
  if (!USER_ID_RE.test(id)) return null;
  const hit = bindingsStore(stateDir).get(id);
  if (!hit || hit.username !== id || !USER_ID_RE.test(hit.botAccountId)) return null;
  return hit;
}

/** 登录用户是否已完成微信扫码绑定（channel-gateway 跳过未绑定账号，避免拖垮企微等同进程渠道） */
export function isWeixinUserBound(stateDir: string, username: string): boolean {
  return readWeixinBinding(stateDir, username) !== null;
}

export type ClaimBindingResult = 'ok' | 'missing' | 'taken' | 'invalid';

/**
 * 把登录用户指向一个机器人文件。不复制 json。
 * 该机器人已被其他登录用户占用时返回 taken，不改对方的绑定。
 * 同一用户再次绑定会覆盖自己的上一条指向。
 */
export function claimWeixinBinding(stateDir: string, username: string, pluginAccountId: string): ClaimBindingResult {
  const user = assertWeixinUsername(username);
  const bot = normalizeBotAccountId(pluginAccountId);
  if (!bot || bot === user || !USER_ID_RE.test(bot) || !bot.endsWith('-im-bot')) return 'invalid';
  let account: WeixinAccount;
  try {
    account = loadWeixinAccount(stateDir, bot);
  } catch {
    return 'missing';
  }
  if (!account.token) return 'missing';
  const holder = listWeixinBindings(stateDir).find((b) => b.botAccountId === bot && b.username !== user);
  if (holder) return 'taken';
  bindingsStore(stateDir).put(user, { username: user, botAccountId: bot, boundAt: new Date().toISOString() });
  return 'ok';
}

/**
 * 强制把机器人绑到 username：先去掉其它用户的指向（不删 *-im-bot.json）。
 * 返回被挤掉的用户名（若有）。
 */
export function forceClaimWeixinBinding(
  stateDir: string,
  username: string,
  pluginAccountId: string,
): { result: ClaimBindingResult; displacedUsername?: string } {
  const user = username.trim();
  const holder = bindingHolderForBot(stateDir, pluginAccountId, user);
  if (holder) removeWeixinBinding(stateDir, holder);
  const result = claimWeixinBinding(stateDir, user, pluginAccountId);
  if (result !== 'ok') {
    return { result };
  }
  return holder ? { result, displacedUsername: holder } : { result };
}

/** 该机器人是否已被其它登录用户占用；返回占用者的用户名 */
export function bindingHolderForBot(stateDir: string, pluginAccountId: string, exceptUsername?: string): string | undefined {
  const bot = normalizeBotAccountId(pluginAccountId);
  const except = exceptUsername?.trim();
  const hit = listWeixinBindings(stateDir).find((b) => b.botAccountId === bot && b.username !== except);
  return hit?.username;
}

export function removeWeixinBinding(stateDir: string, username: string): WeixinUserBinding | null {
  const id = assertWeixinUsername(username);
  const prev = readWeixinBinding(stateDir, id);
  bindingsStore(stateDir).delete(id);
  return prev;
}

/**
 * 进程入口：登录用户必须已有绑定，再读插件写下的那份登录态。
 * 没有绑定、或绑定的文件不在，直接失败。不创建 <用户名>.json，不改读其它机器人。
 */
export function loadBoundWeixinAccount(stateDir: string, username: string): WeixinAccount {
  const user = assertWeixinUsername(username);
  const binding = readWeixinBinding(stateDir, user);
  if (!binding) {
    throw new Error(`登录用户 ${user} 未绑定微信。不会创建 ${user}.json，也不会借用其它机器人登录文件。`);
  }
  try {
    return loadWeixinAccount(stateDir, binding.botAccountId);
  } catch {
    throw new Error(`登录用户 ${user} 绑定的 ${binding.botAccountId}.json 不存在。进程不会改用其它登录文件。`);
  }
}
