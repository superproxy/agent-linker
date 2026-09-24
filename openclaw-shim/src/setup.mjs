/**
 * openclaw/plugin-sdk/setup shim
 * 插件只从这里取 addWildcardAllowFrom（缺失时 catch 降级），完整实现见 core。
 */
export { addWildcardAllowFrom, mergeAllowFromEntries } from './core.mjs';
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from './account-id.mjs';

export function createSetupTranslator() {
  return (key) => key ?? '';
}

export function formatDocsLink(path) {
  return path ?? '';
}

export function hasConfiguredSecretInput(value) {
  return typeof value === 'string' && value.trim().length > 0;
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
