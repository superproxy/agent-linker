export function formatAllowFromLowercase(params) {
  const list = params?.allowFrom;
  return Array.isArray(list) ? list.map((item) => String(item).toLowerCase()) : [];
}
