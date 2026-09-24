export const PAIRING_APPROVED_MESSAGE = 'approved';

export function buildProbeChannelStatusSummary(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}

export function createDefaultChannelRuntimeState(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}
