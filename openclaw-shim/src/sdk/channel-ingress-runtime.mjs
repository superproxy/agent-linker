export function defineStableChannelIngressIdentity(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}

export function fanInChannelIngressLifecycles(lifecycles) {
  const list = Array.isArray(lifecycles) ? lifecycles.filter(Boolean) : [];
  if (list.length === 0) return { lifecycle: undefined };
  const controller = new AbortController();
  for (const life of list) {
    if (life.abortSignal?.aborted) controller.abort();
    life.abortSignal?.addEventListener?.('abort', () => controller.abort(), { once: true });
  }
  return {
    lifecycle: {
      abortSignal: list[0].abortSignal ?? controller.signal,
      onAdoptionFinalizing() {
        for (const life of list) life.onAdoptionFinalizing?.();
      },
      async onAdopted() {
        for (const life of list) await life.onAdopted?.();
      },
      async onAbandoned() {
        for (const life of list) await life.onAbandoned?.();
      },
      onDeferred() {
        for (const life of list) life.onDeferred?.();
      },
      onDeferredHeartbeat() {
        for (const life of list) life.onDeferredHeartbeat?.();
      },
    },
  };
}
