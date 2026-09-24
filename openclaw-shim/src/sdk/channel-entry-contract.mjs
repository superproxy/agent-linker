/**
 * @openclaw/feishu 的 bundled entry：default export 必须带 register()。
 * 工具注册（registerFull）不参与收消息，失败只记日志。
 */
function fileUrl(specifier, importMetaUrl) {
  return new URL(specifier, importMetaUrl).href;
}

function withFeishuHost(runtime) {
  const channel = runtime?.channel ?? {};
  const text = channel.text ?? {};
  return {
    ...runtime,
    logging: runtime?.logging ?? {
      shouldLogVerbose() {
        return false;
      },
    },
    config: {
      ...(runtime?.config ?? {}),
      current() {
        return runtime?.config?.loadConfig?.() ?? runtime?.config?.current?.() ?? {};
      },
      loadConfig() {
        return runtime?.config?.loadConfig?.() ?? {};
      },
    },
    channel: {
      ...channel,
      text: {
        ...text,
        resolveTextChunkLimit() {
          return 4000;
        },
        resolveChunkMode() {
          return 'length';
        },
        chunkMarkdownTextWithMode(textValue) {
          return textValue ? [String(textValue)] : [];
        },
        resolveMarkdownTableMode() {
          return text.resolveMarkdownTableMode?.() ?? 'off';
        },
        convertMarkdownTables(markdown) {
          return text.convertMarkdownTables?.(markdown) ?? markdown;
        },
      },
    },
  };
}

export function defineBundledChannelEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    async register(api) {
      const pluginMod = await import(fileUrl(entry.plugin.specifier, entry.importMetaUrl));
      const plugin = pluginMod[entry.plugin.exportName];
      if (entry.runtime?.specifier) {
        const runtimeMod = await import(fileUrl(entry.runtime.specifier, entry.importMetaUrl));
        const setRuntime = runtimeMod[entry.runtime.exportName];
        if (typeof setRuntime === 'function') setRuntime(withFeishuHost(api.runtime));
      }
      if (typeof plugin?.register === 'function') {
        await plugin.register(api);
      } else if (plugin) {
        api.registerChannel({ id: entry.id, plugin });
      }
      if (typeof entry.registerFull === 'function') {
        try {
          entry.registerFull(api);
        } catch (err) {
          api.logger?.warn?.(
            `[feishu] 跳过工具注册: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}

export function loadBundledEntryExportSync() {
  return () => {};
}
