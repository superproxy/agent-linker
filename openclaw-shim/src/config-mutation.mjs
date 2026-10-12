/**
 * openclaw/plugin-sdk/config-mutation shim
 *
 * 微信/飞书插件在登录流程中写 <OPENCLAW_STATE_DIR>/openclaw.json：
 *   mutateConfigFile({ afterWrite: { mode }, mutate(draft) })   原地修改后写回
 *   replaceConfigFile({ nextConfig, afterWrite: { mode } })     整份覆盖写回
 *
 * 复用 config-runtime 的 loadConfig / writeConfigFile：
 * 写回时通过 host bridge 同步 PluginRuntime 的内存配置视图。
 */
import { loadConfig, writeConfigFile } from './config-runtime.mjs';

/** afterWrite.mode 在 shim 中无额外动作（"auto" 已由 bridge 同步完成） */
async function applyAfterWrite(mode) {
  void mode;
}

/**
 * 读入 openclaw.json → mutate(draft) 原地修改 → 序列化写回。
 * 返回修改后的完整配置。
 */
export async function mutateConfigFile({ afterWrite, mutate }) {
  const draft = loadConfig();
  if (typeof mutate === 'function') {
    mutate(draft);
  }
  await writeConfigFile(draft);
  if (afterWrite) {
    await applyAfterWrite(afterWrite.mode);
  }
  return draft;
}

/**
 * 用 nextConfig 整份覆盖写回 openclaw.json。
 * 返回写入的配置。
 */
export async function replaceConfigFile({ nextConfig, afterWrite }) {
  const next = nextConfig ?? {};
  await writeConfigFile(next);
  if (afterWrite) {
    await applyAfterWrite(afterWrite.mode);
  }
  return next;
}

export default { mutateConfigFile, replaceConfigFile };
