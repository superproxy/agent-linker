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

export function readStringValue(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function asOptionalRecord(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function hasNonEmptyString(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function asBoolean(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function asNullableRecord(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function normalizeNullableString(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function uniqueStrings(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
