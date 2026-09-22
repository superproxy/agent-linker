/**
 * 每个 web 登录账号独立的 openclaw-weixin 插件状态根（OPENCLAW_STATE_DIR），与 role 无关（admin 同规则）。
 * 扫码只写当前账号的 accounts/，避免多人共用一个顶层 accounts/ 导致 binded_redirect / 错绑 token。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertWeixinUsername } from './weixin-binding.js';

export const WEIXIN_LOGIN_USERS_DIR = 'login-users';

export function weixinLoginStateDir(pluginsRoot: string, username: string): string {
  return join(pluginsRoot, WEIXIN_LOGIN_USERS_DIR, assertWeixinUsername(username));
}

/** 确保用户插件状态目录存在（含 accounts/） */
export function ensureWeixinLoginStateDir(pluginsRoot: string, username: string): string {
  const root = weixinLoginStateDir(pluginsRoot, username);
  mkdirSync(join(root, 'openclaw-weixin', 'accounts'), { recursive: true });
  return root;
}

/** 已创建过状态目录的登录用户名（子目录名） */
export function listWeixinLoginUsernames(pluginsRoot: string): string[] {
  const base = join(pluginsRoot, WEIXIN_LOGIN_USERS_DIR);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const name of readdirSync(base, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (/^[A-Za-z0-9._-]+$/.test(name.name)) out.push(name.name);
  }
  return out.sort();
}
