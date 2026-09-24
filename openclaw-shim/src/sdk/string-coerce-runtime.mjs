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

/** 飞书事件字段（message_id、chat_id）是字符串，空串视为缺失。 */
export function readStringValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function asOptionalRecord(value) {
  return isRecord(value) ? value : undefined;
}

export function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function asNullableRecord(value) {
  return isRecord(value) ? value : null;
}

export function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
