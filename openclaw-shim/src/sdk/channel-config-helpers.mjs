export function adaptScopedAccountAccessor(resolve) {
  return (cfg, accountId) => resolve({ cfg, accountId });
}

export function createHybridChannelConfigAdapter(def) {
  return {
    listAccountIds: def.listAccountIds,
    resolveAccount: def.resolveAccount,
    defaultAccountId: def.defaultAccountId,
    resolveAllowFrom: def.resolveAllowFrom,
    formatAllowFrom: def.formatAllowFrom,
  };
}
