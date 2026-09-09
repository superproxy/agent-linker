/**
 * openclaw/plugin-sdk/config-runtime shim
 *
 * 微信插件在 triggerWeixinChannelReload 里 lazy import：
 *   loadConfig()      读 <OPENCLAW_STATE_DIR>/openclaw.json
 *   writeConfigFile() 写该文件 + 通过 host bridge 同步内存配置
 *
 * host（gateway PluginRuntime）可调用 setConfigRuntimeHostWrite 注册
 * 写回调，让插件写入的配置也反映到 PluginRuntime.config 内存视图。
 */
import os from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

let hostWriteBridge = null;

/** host 注册写回调（config-runtime 由 host 提供 stateDir 语义） */
export function setConfigRuntimeHostWrite(fn) {
  hostWriteBridge = fn;
}

function configPath() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(os.homedir(), '.openclaw');
  return join(stateDir, 'openclaw.json');
}

/** 读 <stateDir>/openclaw.json（不存在返回 {}） */
export function loadConfig() {
  const filePath = configPath();
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写 <stateDir>/openclaw.json 并通知 host 同步内存配置 */
export async function writeConfigFile(next) {
  const filePath = configPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next ?? {}, null, 2), 'utf-8');
  if (hostWriteBridge) {
    try {
      await hostWriteBridge(next ?? {});
    } catch {
      // best-effort：host 同步失败不影响插件
    }
  }
}

export default { loadConfig, writeConfigFile, setConfigRuntimeHostWrite };
