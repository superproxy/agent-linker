export const DEFAULT_ACCOUNT_ID = 'default';

export function normalizeAccountId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return id || DEFAULT_ACCOUNT_ID;
}

export function normalizeOptionalAccountId(value) {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().toLowerCase();
  return id || undefined;
}

export function hasConfiguredAccountValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 飞书 accounts.default 与顶层 appId 都能列出账号。 */
export function createAccountListHelpers(channel, opts = {}) {
  const listAccountIds = (cfg) => {
    const section = cfg?.channels?.[channel] ?? {};
    const accounts = section.accounts;
    const ids = [];
    if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
      for (const key of Object.keys(accounts)) {
        if (!ids.includes(key)) ids.push(key);
      }
    }
    if (opts.allowUnlistedDefaultAccount && opts.hasImplicitDefaultAccount?.(cfg) && !ids.includes(DEFAULT_ACCOUNT_ID)) {
      ids.unshift(DEFAULT_ACCOUNT_ID);
    }
    return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
  };
  return {
    listAccountIds,
    resolveDefaultAccountId(cfg) {
      const ids = listAccountIds(cfg);
      return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
    },
    resolveAccountConfig(cfg, accountId) {
      const section = cfg?.channels?.[channel] ?? {};
      const accounts = section.accounts;
      const scoped =
        accounts && typeof accounts === 'object' && !Array.isArray(accounts) ? accounts[accountId] ?? {} : {};
      const { accounts: _accounts, ...rest } = section;
      return { ...rest, ...scoped };
    },
  };
}

export function resolveMergedAccountConfig(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
