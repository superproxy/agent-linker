export class PlatformMessageNotDispatchedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PlatformMessageNotDispatchedError';
  }
}

export function formatErrorMessage(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export function collectErrorGraphCandidates(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }

export class toStringifiedError extends Error { constructor(message, options) { super(message, options); this.name = 'toStringifiedError'; } }
