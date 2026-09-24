export function parseStrictPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function clampTimerTimeoutMs(value, fallback = 30_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
