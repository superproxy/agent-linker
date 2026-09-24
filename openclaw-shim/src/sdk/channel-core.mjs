export function createChatChannelPlugin(def) {
  const base = def?.base ?? {};
  return { ...def, ...base, id: base.id ?? def?.id };
}

export function buildChannelOutboundSessionRoute() {
  return {};
}

export function stripChannelTargetPrefix(value) {
  return String(value ?? '').replace(/^(feishu|lark|user|chat):/i, '');
}
