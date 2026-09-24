import type { AuthGuard } from '../users/auth.js';
import { persistEnsureWeixinAccount } from '../../config/persist.js';

type HeaderCarrier = { headers: { authorization?: string }; ip?: string };

/** 后台保存渠道配置时的登录用户名（会话 / 个人 token / local）；纯 gateway token 无用户则 undefined */
export function resolveChannelConfigOwnerUsername(authGuard: AuthGuard, request: HeaderCarrier): string | undefined {
  const user = authGuard.sessionUser(request);
  const name = user?.username?.trim();
  return name || undefined;
}

/** 与微信扫码绑定一致：登记 overlay weixin.accounts，并供 channels 企微 ct_ 引导使用 */
export function bindChannelGatewayTaskOwner(
  configPath: string,
  ownerUsername: string,
  runtimeGatewayDir?: string,
): void {
  const id = ownerUsername.trim();
  if (!id) return;
  persistEnsureWeixinAccount(configPath, id, runtimeGatewayDir);
}
