/** 本机进程管理地址解析（与当前「网关连接」无关） */
export const DEFAULT_BASE = 'http://127.0.0.1:8787';
export const LS_LOCAL_BASE_KEY = 'linkagent.gw.localBase';

export function isLoopbackHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function isLoopbackBase(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function rememberLocalBase(url: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (isLoopbackBase(trimmed)) storage.setItem(LS_LOCAL_BASE_KEY, trimmed);
}

export function localProcessBase(
  origin: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): string {
  if (isLoopbackBase(origin)) return origin;
  const saved = storage.getItem(LS_LOCAL_BASE_KEY);
  if (saved) return saved;
  return DEFAULT_BASE;
}
