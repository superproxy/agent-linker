export function createAccountStatusSink(params) {
  return (status) => params?.setStatus?.(status);
}

export function createMessageReceiptFromOutboundResults() {
  return {};
}

export function createReplyToFanout() {
  return {};
}

export function createRuntimeOutboundDelegates() {
  return {};
}

export function defineChannelMessageAdapter(def) {
  return def;
}

export function createReplyPrefixContext(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function DEFAULT_INGRESS_ADOPTION_STALL_MS(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function bindIngressLifecycleToReplyOptions(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function createChannelIngressError(name, options) {
  const withReason = options?.withReason === true;
  class IngressError extends Error {
    constructor(reasonOrMessage, message, extra) {
      const text = withReason ? message ?? reasonOrMessage : reasonOrMessage;
      super(typeof text === 'string' ? text : String(text ?? name));
      this.name = typeof name === 'string' ? name : 'ChannelIngressError';
      if (withReason) this.reason = reasonOrMessage;
      if (extra?.cause) this.cause = extra.cause;
    }
  }
  return IngressError;
}

export function createChannelIngressMonitor(opts) {
  return {
    async admit(rawEnvelope, meta) {
      const controller = new AbortController();
      await opts?.deliver?.(rawEnvelope, {
        abortSignal: controller.signal,
        onAdopted() {},
        async onAbandoned() {},
        onAdoptionFinalizing() {},
        onDeferred() {},
      }, { id: meta?.facts?.eventId ?? 'feishu' });
    },
    async stop() {},
    start() {},
    async waitForIdle() {},
  };
}

export function createChannelMessageReplyPipeline(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function formatChannelProgressDraftLineForEntry(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveAgentOutboundIdentity(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveChannelPreviewStreamMode(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveChannelStreamingBlockEnabled(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
