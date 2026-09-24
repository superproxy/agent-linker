function chainableSchema() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'shape') return {};
        if (typeof prop === 'symbol') return undefined;
        return () => chainableSchema();
      },
    },
  );
}

export function buildSecretInputSchema() {
  return chainableSchema();
}

export function hasConfiguredSecretInput(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
