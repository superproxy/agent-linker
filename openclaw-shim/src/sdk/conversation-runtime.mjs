export function getSessionBindingService() {
  return {
    listBySession() {
      return [];
    },
  };
}

export function registerSessionBindingAdapter(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveThreadBindingConversationIdFromBindingId(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveThreadBindingIdleTimeoutMsForChannel(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveThreadBindingMaxAgeMsForChannel(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function unregisterSessionBindingAdapter(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function ensureConfiguredBindingRouteReady(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveConfiguredBindingRoute(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function resolveRuntimeConversationBindingRoute(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
