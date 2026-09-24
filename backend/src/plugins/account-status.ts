export interface PluginAccountStatus {
  running: boolean;
  lastError: string | null;
  lastStartAt: number | null;
}

/** 合并插件 setStatus 补丁（webhook statusSink 可能只传部分字段） */
export function mergePluginAccountStatus(
  prev: PluginAccountStatus | undefined,
  patch: Record<string, unknown>,
): PluginAccountStatus {
  const running = patch.running !== undefined ? patch.running === true : (prev?.running ?? false);
  const lastError =
    patch.lastError !== undefined ? (patch.lastError as string | null) : (prev?.lastError ?? null);
  const lastStartAt =
    patch.lastStartAt !== undefined
      ? (patch.lastStartAt as number | null)
      : (prev?.lastStartAt ?? Date.now());
  return { running, lastError, lastStartAt };
}
