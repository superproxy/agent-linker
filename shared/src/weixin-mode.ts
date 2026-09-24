/** 个人微信收发模式：raw=ilink/weixin-bot，claw=OpenClaw 插件 */
export type WeixinMode = 'raw' | 'claw';

const LEGACY_RAW = new Set(['raw', 'external', 'weixin-bot']);
const LEGACY_CLAW = new Set(['claw', 'openclaw-weixin-plugin']);

/** 任意 yaml/env/overlay 取值 → 规范 raw | claw */
export function normalizeWeixinMode(input: string | undefined | null): WeixinMode {
  const m = (input ?? '').trim().toLowerCase();
  if (LEGACY_CLAW.has(m)) return 'claw';
  if (LEGACY_RAW.has(m)) return 'raw';
  return 'raw';
}

export function weixinModeUsesPlugin(mode: WeixinMode): boolean {
  return mode === 'claw';
}

export function channelGatewayFromWeixinMode(mode: WeixinMode): { weixin: boolean; weixinPlugin: boolean } {
  return { weixin: true, weixinPlugin: mode === 'claw' };
}

export function weixinModeFromChannelGateway(weixin: boolean, weixinPlugin: boolean): WeixinMode | null {
  if (!weixin) return null;
  return weixinPlugin ? 'claw' : 'raw';
}
