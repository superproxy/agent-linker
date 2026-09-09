#!/usr/bin/env bash
# linkagent gateway 启停脚本
#   scripts/server.sh            启动（若已在运行则提示）
#   scripts/server.sh start      同无参数
#   scripts/server.sh stop       停止
#   scripts/server.sh restart    重启
#   scripts/server.sh status     查看状态
#   scripts/server.sh log        跟随日志
#   scripts/server.sh foreground 前台运行（Ctrl-C 退出，开发用）
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO/.runtime-state/server.pid"
LOG_FILE="$REPO/.runtime-state/server.log"
HOST_URL="http://127.0.0.1:8787"

is_running() {
  # pid 文件有效，或 8787 端口已被监听，都视为运行中
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    return 0
  fi
  if [ -n "$(lsof -ti:8787 2>/dev/null)" ]; then
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
    local pid
    pid="$(lsof -ti:8787 2>/dev/null | head -1)"
    [ -n "$pid" ] && write_pid "$pid"
    echo "gateway 已在运行 (pid $(cat "$PID_FILE"))"
    return 0
  fi
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "→ 后台启动 gateway ..."
  nohup pnpm --filter @linkagent/backend start >>"$LOG_FILE" 2>&1 &
  write_pid "$!"
  # 最多等 20s 健康检查通过
  for _ in $(seq 1 20); do
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
    echo "gateway 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pids
  pids="$(lsof -ti:8787 2>/dev/null | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in $(seq 1 15); do
    [ -z "$(lsof -ti:8787 2>/dev/null)" ] && break
    sleep 1
  done
  rm -f "$PID_FILE"
  echo "gateway 已停止"
}

do_status() {
  if is_running; then
    local pid
    pid="$(lsof -ti:8787 2>/dev/null | head -1)"
    echo "运行中 pid=$pid  url=${HOST_URL}/v1"
  else
    echo "未运行"
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
    echo "→ 前台运行 gateway（Ctrl-C 停止）..."
    cd "$REPO" && exec pnpm --filter @linkagent/backend start
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|foreground}"
    exit 1
    ;;
esac
