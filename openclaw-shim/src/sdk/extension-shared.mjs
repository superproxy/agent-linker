export function createDeferred(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}

export function readPluginPackageVersion(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}

export function resolveAmbientNodeProxyAgent(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}
