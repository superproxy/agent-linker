import type { AuthMode } from '@linkagent/shared';
import type { Logger } from '../plugins/manager.js';

/** local 模式本机默认用户名（与 AuthGuard LOCAL_DEFAULT_USER.username 一致） */
export const LOCAL_CHANNEL_OWNER = 'local';

/**
 * 企微任务空间 owner。
 * - auth.mode=local：固定 `local`，对接 /v1 用 gateway token（不换 ct_）
 * - 其它模式：与微信 bot 同一套 weixin.accounts / wecomOwner / LINKAGENT_ACCOUNT_ID
 */
export function resolveWecomOwnerUsername(
  accounts: string[],
  wecomOwnerConfig: string,
  log: Pick<Logger, 'warn' | 'info'>,
  authMode?: AuthMode,
): string | undefined {
  if (authMode === 'local') {
    log.info('auth.mode=local：企微任务 owner=local，/v1 使用 gateway token');
    return LOCAL_CHANNEL_OWNER;
  }
  const fromEnv = process.env.LINKAGENT_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  const explicit = wecomOwnerConfig.trim();
  if (explicit) return explicit;
  if (accounts.length === 1) return accounts[0];
  if (accounts.length > 1) {
    const pick = accounts[0];
    log.warn(
      `多个 weixin.accounts，企微默认 owner=${pick}；可在 channels.yaml 的 channelGateway.wecomOwner 指定`,
    );
    return pick;
  }
  return undefined;
}
