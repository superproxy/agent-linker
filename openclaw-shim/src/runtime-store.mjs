/**
 * openclaw/plugin-sdk/runtime-store shim
 *
 * 照搬 openclaw dist/plugin-sdk/runtime-store 的实现（MIT）：
 * 全局（Symbol.for 键）注册表保存各插件的 runtime，供插件内部
 * `createPluginRuntimeStore("...")` 后 getRuntime() 取回 host 注入的
 * PluginRuntime 实例。
 */
const pluginRuntimeStoreRegistryKey = Symbol.for('openclaw.plugin-sdk.runtime-store-registry');

function getNamedPluginRuntimeStoreRegistry() {
  const globalRecord = globalThis;
  globalRecord[pluginRuntimeStoreRegistryKey] ??= new Map();
  return globalRecord[pluginRuntimeStoreRegistryKey];
}

function getNamedPluginRuntimeStoreSlot(key) {
  const registry = getNamedPluginRuntimeStoreRegistry();
  let slot = registry.get(key);
  if (!slot) {
    slot = { runtime: null };
    registry.set(key, slot);
  }
  return slot;
}

function pluginRuntimeStoreKeyForPluginId(pluginId) {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) throw new Error('createPluginRuntimeStore: pluginId must not be empty');
  return `plugin-runtime:${normalizedPluginId}`;
}

function resolvePluginRuntimeStoreOptions(options) {
  if (typeof options === 'string') {
    return { key: options, errorMessage: options };
  }
  if ('pluginId' in options) {
    return { key: pluginRuntimeStoreKeyForPluginId(options.pluginId), errorMessage: options.errorMessage };
  }
  return options;
}

/** 兼容 legacy error-message 字符串与结构化 options 两种签名 */
export function createPluginRuntimeStore(options) {
  const resolved = resolvePluginRuntimeStoreOptions(options);
  const slot = typeof options === 'string' ? { runtime: null } : getNamedPluginRuntimeStoreSlot(resolved.key);
  return {
    setRuntime(next) {
      slot.runtime = next;
    },
    clearRuntime() {
      slot.runtime = null;
    },
    tryGetRuntime() {
      return slot.runtime ?? null;
    },
    getRuntime() {
      if (slot.runtime === null) throw new Error(resolved.errorMessage);
      return slot.runtime;
    },
  };
}

export default { createPluginRuntimeStore };
