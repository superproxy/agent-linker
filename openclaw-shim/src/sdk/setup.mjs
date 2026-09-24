export const DEFAULT_ACCOUNT_ID = 'default';

export function createSetupTranslator(def) {
  return def ?? {};
}

export function formatDocsLink(path) {
  return path ?? '';
}

export function hasConfiguredSecretInput(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function mergeAllowFromEntries(...lists) {
  return lists.flat().filter(Boolean);
}

export function patchScopedAccountConfig(params) {
  return params?.cfg ?? {};
}

export function patchTopLevelChannelConfigSection(params) {
  return params?.cfg ?? {};
}

export function promptSingleChannelSecretInput() {
  return undefined;
}

export function setSetupChannelEnabled(cfg) {
  return cfg;
}

export function splitSetupEntries(value) {
  return Array.isArray(value) ? value : [];
}
