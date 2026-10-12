#!/usr/bin/env bash
# linkagent gateway 启停脚本（仅管理 **本安装根** 下的 gateway，不占用全局 8787 判断）
# 安装根：LINKAGENT_HOME，否则为仓库根（脚本所在目录的上级）
#   scripts/server.sh start|stop|restart|status|log|foreground
set -u

SCRIPT_REPO="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${LINKAGENT_HOME:-$(pwd)}"
INSTALL="$(cd "$INSTALL" && pwd)"
REPO="$SCRIPT_REPO"
if [ -f "$INSTALL/pnpm-workspace.yaml" ]; then
  REPO="$INSTALL"
fi
STATE="$INSTALL/.runtime-state"
PID_FILE="$STATE/server.pid"
LOG_FILE="$STATE/server.log"
PORT="$(node "$(dirname "$0")/resolve-gateway-port.mjs")"
HOST_URL="http://127.0.0.1:${PORT}"

is_running() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    return 0
  fi
  return 1
}

write_pid() {
  mkdir -p "$(dirname "$PID_FILE")"
  echo "$1" >"$PID_FILE"
}

do_start() {
  if is_running; then
    echo "gateway 已在运行 (pid $(cat "$PID_FILE")，安装根 $INSTALL，${HOST_URL}/v1)"
    return 0
  fi
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "→ 后台启动 gateway（安装根 $INSTALL，期望端口 ${PORT}）..."
  (
    cd "$REPO"
    nohup pnpm --filter @linkagent/backend start >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  for _ in $(seq 1 25); do
    PORT="$(node "$(dirname "$0")/resolve-gateway-port.mjs")"
    HOST_URL="http://127.0.0.1:${PORT}"
    if curl -sS -m 2 "$HOST_URL/healthz" >/dev/null 2>&1; then
      echo "✅ gateway 已就绪：${HOST_URL}/v1 （日志 ${LOG_FILE}）"
      return 0
    fi
    sleep 1
  done
  echo "⚠️  启动超时，最近日志："
  tail -n 15 "$LOG_FILE"
  return 1
}

do_stop() {
  if ! is_running; then
    echo "gateway 未在运行（安装根 $INSTALL）"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  echo "→ 停止 gateway (pid $pid) ..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "gateway 已停止"
}

do_status() {
  PORT="$(node "$(dirname "$0")/resolve-gateway-port.mjs")"
  HOST_URL="http://127.0.0.1:${PORT}"
  if is_running; then
    echo "运行中 pid=$(cat "$PID_FILE")  install=$INSTALL  url=${HOST_URL}/v1"
  else
    echo "未运行（安装根 $INSTALL）"
  fi
}

do_log() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "暂无日志（尚未启动过）"
    return 0
  fi
  tail -f "$LOG_FILE"
}

case "${1:-start}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop && do_start ;;
  status) do_status ;;
  log) do_log ;;
  foreground)
    echo "→ 前台运行 gateway（Ctrl-C 停止，安装根 $INSTALL）..."
    cd "$REPO" && exec pnpm --filter @linkagent/backend start
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|foreground}"
    exit 1
    ;;
esac
