const passthrough = {
  normalize(params) {
    return { entry: params?.entry, changed: false };
  },
};

export function asObjectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

export function defineChannelAliasMigration() {
  return { legacyConfigRules: [], config: passthrough };
}

export function defineKeyMoveMigration() {
  return { config: passthrough };
}

export function defineStrayPluginEntryConfigMigration() {
  return { legacyConfigRule: { path: ['channels', 'feishu'] }, config: passthrough };
}

export function hasLegacyAccountStreamingAliases() {
  return false;
}

export function normalizeChannelConfigEntries(entries) {
  return entries ?? [];
}
