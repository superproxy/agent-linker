/**
 * openclaw/plugin-sdk/channel-message shim
 *
 * createTypingCallbacks：把渠道的 typing start/stop 回调包装成带
 * keepalive 心跳 + 去重语义的 { start, stop }。
 * 对齐 openclaw：start 幂等（重复调用不重复发起），stop 取消 keepalive。
 */
export function createTypingCallbacks({ start, stop, onStartError, onStopError, keepaliveIntervalMs = 0 }) {
  let started = false;
  let keepaliveTimer = null;

  const fireStart = async () => {
    if (!start) return;
    try {
      await start();
    } catch (err) {
      onStartError?.(err);
    }
  };

  const fireStop = async () => {
    if (!stop) return;
    try {
      await stop();
    } catch (err) {
      onStopError?.(err);
    }
  };

  const begin = async () => {
    if (started) return;
    started = true;
    await fireStart();
    if (keepaliveIntervalMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (started) void fireStart();
      }, keepaliveIntervalMs);
      if (keepaliveTimer.unref) keepaliveTimer.unref();
    }
  };

  const end = async () => {
    if (!started) return;
    started = false;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    await fireStop();
  };

  return { start: begin, stop: end };
}

export default { createTypingCallbacks };
