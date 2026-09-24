export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeOptionalLowercaseString(value) {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized || undefined;
}

export function normalizeStringEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
