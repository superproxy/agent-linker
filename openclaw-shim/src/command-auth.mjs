/**
 * openclaw/plugin-sdk/command-auth shim
 *
 * 微信插件 process-message 里用到的框架命令鉴权入口：
 * - resolveSenderCommandAuthorizationWithRuntime：DM 场景判断
 *   senderAllowedForCommands + commandAuthorized
 * - resolveDirectDmAuthorizationOutcome：把鉴权结果收敛为
 *   allowed / disabled / unauthorized（插件对 disabled/unauthorized 直接丢弃消息）
 *
 * 复用 host 注入的 channelRuntime.commands 面（shouldComputeCommandAuthorized /
 * resolveCommandAuthorizedFromAuthorizers），语义对齐 openclaw。
 */

/** DM 鉴权结果收敛 */
export function resolveDirectDmAuthorizationOutcome({ isGroup = false, dmPolicy = 'pairing', senderAllowedForCommands = false } = {}) {
  if (isGroup) return 'allowed'; // 群聊策略由 groupPolicy 单独处理；微信插件一期仅 DM
  switch (dmPolicy) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'disabled';
    case 'pairing':
    default:
      return senderAllowedForCommands ? 'allowed' : 'unauthorized';
  }
}

/**
 * 计算发送者命令授权。
 * params（openclaw 契约）：
 *   { cfg, rawBody, isGroup, dmPolicy, configuredAllowFrom, configuredGroupAllowFrom,
 *     senderId, isSenderAllowed(id, list), readAllowFromStore(), runtime }
 * 返回 { senderAllowedForCommands, commandAuthorized }
 */
export async function resolveSenderCommandAuthorizationWithRuntime(params) {
  const {
    rawBody = '',
    isGroup = false,
    configuredAllowFrom = [],
    configuredGroupAllowFrom = [],
    senderId = '',
    isSenderAllowed,
    readAllowFromStore,
    runtime,
  } = params ?? {};

  // 合并 allowFrom：配置列表 + pairing store（账号 userId 兜底，由插件 readAllowFromStore 提供）
  let storeList = [];
  try {
    storeList = (await readAllowFromStore?.()) ?? [];
  } catch {
    storeList = [];
  }
  const effectiveList = [
    ...(Array.isArray(configuredAllowFrom) ? configuredAllowFrom : []),
    ...(isGroup && Array.isArray(configuredGroupAllowFrom) ? configuredGroupAllowFrom : []),
    ...(Array.isArray(storeList) ? storeList : []),
  ];
  const senderAllowedForCommands = isSenderAllowed
    ? isSenderAllowed(senderId, effectiveList)
    : effectiveList.length === 0 || effectiveList.includes(senderId);

  // 仅当消息疑似命令（/xxx 等）时才计算 commandAuthorized；普通闲聊不需要
  const needAuth = runtime?.shouldComputeCommandAuthorized?.(rawBody, params?.cfg) ?? false;
  let commandAuthorized = true;
  if (needAuth) {
    commandAuthorized =
      runtime?.resolveCommandAuthorizedFromAuthorizers?.({
        useAccessGroups: false,
        authorizers: [{ configured: true, allowed: senderAllowedForCommands }],
        modeWhenAccessGroupsOff: 'deny',
      }) ?? senderAllowedForCommands;
  }
  return { senderAllowedForCommands, commandAuthorized };
}

export default { resolveSenderCommandAuthorizationWithRuntime, resolveDirectDmAuthorizationOutcome };
