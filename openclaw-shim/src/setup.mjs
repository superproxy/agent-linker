/**
 * openclaw/plugin-sdk/setup shim
 * 插件只从这里取 addWildcardAllowFrom（缺失时 catch 降级），完整实现见 core。
 */
export { addWildcardAllowFrom, mergeAllowFromEntries } from './core.mjs';
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from './account-id.mjs';
export default { addWildcardAllowFrom, mergeAllowFromEntries, DEFAULT_ACCOUNT_ID, normalizeAccountId };
