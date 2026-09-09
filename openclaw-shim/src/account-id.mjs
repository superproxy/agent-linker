/**
 * openclaw/plugin-sdk/account-id shim
 *
 * 照搬 openclaw dist/plugin-sdk/account-id 实现（MIT）：
 * accountId 规范化（小写、非法字符替换为 '-'、截断 64、保留缓存）。
 */
const DEFAULT_ACCOUNT_ID = 'default';
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;

const normalizedAccountIdCache = new Map();
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeLowercaseStringOrEmpty(value) {
  const trimmed = (value ?? '').trim();
  return trimmed.toLowerCase();
}

function canonicalizeAccountId(value) {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (VALID_ID_RE.test(value)) return normalized;
  return normalized
    .replace(INVALID_CHARS_RE, '-')
    .replace(LEADING_DASH_RE, '')
    .replace(TRAILING_DASH_RE, '')
    .slice(0, 64);
}

function normalizeCanonicalAccountId(value) {
  const canonical = canonicalizeAccountId(value);
  if (!canonical || BLOCKED_KEYS.has(canonical)) return undefined;
  return canonical;
}

function resolveCachedCanonicalAccountId(value) {
  if (normalizedAccountIdCache.has(value)) return normalizedAccountIdCache.get(value);
  const normalized = normalizeCanonicalAccountId(value);
  normalizedAccountIdCache.set(value, normalized);
  if (normalizedAccountIdCache.size > ACCOUNT_ID_CACHE_MAX) {
    const oldestKey = normalizedAccountIdCache.keys().next().value;
    normalizedAccountIdCache.delete(oldestKey);
  }
  return normalized;
}

export function normalizeAccountId(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  return resolveCachedCanonicalAccountId(trimmed) ?? 'default';
}

export function normalizeOptionalAccountId(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  return resolveCachedCanonicalAccountId(trimmed);
}

export { DEFAULT_ACCOUNT_ID };

export default { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId };
