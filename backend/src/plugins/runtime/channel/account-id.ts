/**
 * accountId 规范化（与 openclaw-shim 的 account-id 实现一致，类型侧独立一份）
 */
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;

export const DEFAULT_ACCOUNT_ID = 'default';

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  const canonical = trimmed.toLowerCase().replace(INVALID_CHARS_RE, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 64);
  return canonical || DEFAULT_ACCOUNT_ID;
}

export function normalizeOptionalAccountId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const canonical = normalizeAccountId(trimmed);
  return canonical === DEFAULT_ACCOUNT_ID ? undefined : canonical;
}

export function isValidAccountId(value: string): boolean {
  return VALID_ID_RE.test(value);
}
