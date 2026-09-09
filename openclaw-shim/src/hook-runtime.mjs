/**
 * openclaw/plugin-sdk/hook-runtime shim
 *
 * 微信插件 outbound-hooks 里用到的 hook 数据构造与 fire-and-forget 执行。
 * linkagent 不运行 hook 系统（getGlobalHookRunner 返回无 hook 的 runner），
 * 这些函数实际不会被调用，仅保证 import 面存在。
 */

/** fire-and-forget：吞掉未处理 rejection，避免 unhandledRejection */
export function fireAndForgetHook(promise, label = 'plugin hook') {
  Promise.resolve(promise).catch((err) => {
    console.warn(`[openclaw-shim] ${label}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** 构造 canonical message_sent hook context（透传 + 规范化字段名） */
export function buildCanonicalSentMessageHookContext(params = {}) {
  return {
    channelId: params.channelId,
    accountId: params.accountId,
    conversationId: params.conversationId ?? params.to,
    to: params.to,
    content: params.content,
    success: Boolean(params.success),
    error: params.error,
    runId: params.runId,
  };
}

/** canonical context → 插件 message context */
export function toPluginMessageContext(canonical = {}) {
  return {
    channel: { id: canonical.channelId, accountId: canonical.accountId },
    conversationId: canonical.conversationId,
    to: canonical.to,
    content: canonical.content,
    runId: canonical.runId,
  };
}

/** canonical context → message_sent event */
export function toPluginMessageSentEvent(canonical = {}) {
  return {
    type: 'message_sent',
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    to: canonical.to,
    content: canonical.content,
    success: Boolean(canonical.success),
    error: canonical.error,
    runId: canonical.runId,
  };
}

export default { fireAndForgetHook, buildCanonicalSentMessageHookContext, toPluginMessageContext, toPluginMessageSentEvent };
