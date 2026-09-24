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

export function createChannelIngressError(message) {
  const err = new Error(typeof message === 'string' ? message : 'channel ingress');
  err.name = 'createChannelIngressError';
  return err;
}

export function createChannelIngressMonitor(opts) {
  return {
    async admit(rawEnvelope, meta) {
      await opts?.deliver?.(rawEnvelope, {
        onAdopted() {},
        async onAbandoned() {},
        onAdoptionFinalizing() {},
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
