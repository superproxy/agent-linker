export function createChannelReplayGuard() {
  const seen = new Map();
  return {
    async warmup() {
      return undefined;
    },
    async claim(key) {
      const id = String(key ?? '').trim();
      if (!id) return { kind: 'invalid' };
      if (seen.has(id)) return { kind: 'duplicate' };
      seen.set(id, Date.now());
      return {
        kind: 'claimed',
        handle: {
          async commit() {
            return true;
          },
          release() {
            seen.delete(id);
          },
        },
      };
    },
    async forget(key) {
      seen.delete(String(key ?? ''));
      return true;
    },
    async hasRecent(key) {
      return seen.has(String(key ?? ''));
    },
  };
}
