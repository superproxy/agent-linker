/**
 * openclaw/plugin-sdk/plugin-runtime shim
 *
 * 微信插件从这里取 getGlobalHookRunner()。linkagent 不运行 hook 系统，
 * 返回一个「无任何 hook」的 runner：插件的 hasHooks(...) 恒 false，
 * message_sending/message_sent hook 走跳过路径，发送行为不受影响。
 */
const NO_HOOKS_RUNNER = {
  hasHooks() {
    return false;
  },
  async runMessageSending() {
    return undefined;
  },
  async runMessageSent() {
    return undefined;
  },
};

export function getGlobalHookRunner() {
  return NO_HOOKS_RUNNER;
}

export function hasGlobalHooks() {
  return false;
}

export function initializeGlobalHookRunner() {
  return NO_HOOKS_RUNNER;
}

export default { getGlobalHookRunner, hasGlobalHooks, initializeGlobalHookRunner };
