export function compileAllowlist(allowFrom) {
  const list = Array.isArray(allowFrom) ? allowFrom : [];
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

export function resolveAllowlistMatchByCandidates(params) {
  const allow = new Set(compileAllowlist(params?.allowFrom));
  const candidates = params?.candidates ?? [];
  const hit = candidates.find((item) => allow.has(String(item).trim().toLowerCase()));
  return hit ? { allowed: true, match: hit } : { allowed: allow.size === 0, match: undefined };
}

export function formatAllowFromLowercase(params) {
  const list = params?.allowFrom;
  return Array.isArray(list) ? list.map((item) => String(item).toLowerCase()) : [];
}
