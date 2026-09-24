export function parseStrictPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function clampTimerTimeoutMs(value, fallback = 30_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function parseStrictNonNegativeInteger(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function isFutureDateTimestampMs(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function asDateTimestampMs(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveExpiresAtMsFromDurationMs(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveTimerTimeoutMs(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveDateTimestampMs(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveExpiresAtMsFromDurationSeconds(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolvePromptHistoryLimit(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
