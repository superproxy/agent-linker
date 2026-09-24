export function createPairingPrefixStripper() {
  return (value) => String(value ?? '').replace(/^(feishu|lark|user|open_id):/i, '');
}

export function createChannelPairingController(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
