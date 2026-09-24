import type { Logger } from '../plugins/manager.js';

/** 企微 ct_ / 任务空间 owner：与微信 bot 同一套 weixin.accounts 登录用户列表 */
export function resolveWecomOwnerUsername(
  accounts: string[],
  wecomOwnerConfig: string,
  log: Pick<Logger, 'warn'>,
): string | undefined {
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
