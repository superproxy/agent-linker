export class ToolAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolAuthorizationError';
  }
}

export function createActionGate(actions) {
  return (name, defaultOn = false) => {
    if (!actions || typeof actions !== 'object') return defaultOn;
    if (actions[name] === false) return false;
    if (actions[name] === true) return true;
    return defaultOn;
  };
}

export function optionalPositiveIntegerSchema(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
