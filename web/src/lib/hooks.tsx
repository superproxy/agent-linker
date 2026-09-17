import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';
import { errText } from './constants';

/** 401 统一登出回调 */
export type AuthErrorHandler = (e: unknown) => boolean;

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setData: (v: T | null) => void;
}

/**
 * 通用异步数据加载：挂载即拉取，返回 data/loading/error/reload。
 * onAuthError 命中时不再写错误态（上层会登出）。
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts?: { onAuthError?: AuthErrorHandler; intervalMs?: number },
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    try {
      const r = await fnRef.current();
      if (aliveRef.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (opts?.onAuthError?.(e)) return;
      if (aliveRef.current) setError(errText(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    void reload();
    const t = opts?.intervalMs ? setInterval(() => void reload(), opts.intervalMs) : undefined;
    return () => {
      aliveRef.current = false;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, opts?.intervalMs]);

  return { data, loading, error, reload, setData };
}

// ── 全局刷新总线：顶栏「刷新」递增 tick，各页把 tick 加入 useAsync 依赖即可 ──
const RefreshContext = createContext<{ tick: number; bump: () => void }>({ tick: 0, bump: () => {} });

export function RefreshProvider(props: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((v) => v + 1), []);
  return <RefreshContext.Provider value={{ tick, bump }}>{props.children}</RefreshContext.Provider>;
}

export function useRefreshTick(): { tick: number; bump: () => void } {
  return useContext(RefreshContext);
}
