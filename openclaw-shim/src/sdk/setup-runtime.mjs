export function createClackPrompter(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}
