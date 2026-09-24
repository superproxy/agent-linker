export function createPairingPrefixStripper() {
  return (value) => String(value ?? '').replace(/^(feishu|lark|user|open_id):/i, '');
}
