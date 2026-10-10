import { join } from 'node:path';

/** 与 backend/src/install/layout.ts defaultInstallRoot 保持一致 */
export function defaultInstallRoot() {
  if (process.platform === 'win32') {
    const base = process.env.ProgramData ?? 'C:\\ProgramData';
    return join(base, 'linkagent');
  }
  return '/opt/agent-linker';
}

export function resolveInstallDir(env = process.env) {
  const explicit = env.LINKAGENT_INSTALL?.trim();
  if (explicit) return explicit;
  return defaultInstallRoot();
}
