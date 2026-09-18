#!/usr/bin/env bash
# linkagent node 启停脚本（远程节点连接器，反向 WebSocket 连入网关）
# Windows 请用 scripts/node.ps1，或根目录 pnpm node:*（scripts/node-ctl.mjs 按平台分发）。
#   scripts/node.sh                       启动默认节点（若已在运行则提示）
#   scripts/node.sh start [name]          启动节点（可给实例名，支持本机多实例）
#   scripts/node.sh stop [name]           停止
#   scripts/node.sh restart [name]        重启
#   scripts/node.sh status [name]         查看状态（不带 name 列出全部实例）
#   scripts/node.sh log [name]            跟随日志
#   scripts/node.sh foreground [name]     前台运行（Ctrl-C 退出，开发用）
#
# 节点配置（环境变量，或写入 .runtime-state/node[-<name>].env，KEY=VALUE 每行一条）：
#   LINKAGENT_GATEWAY_URL    网关地址（默认 ws://127.0.0.1:8787）
#   LINKAGENT_GATEWAY_TOKEN  网关 token（网关开启 auth 时必填）
#   LINKAGENT_NODE_AGENTS    逗号分隔的 agent id（缺省上报默认 4 种）
#   LINKAGENT_NODE_ID        一般不填，首次连接由网关签发并持久化
# 命名实例会自动把 LINKAGENT_NODE_NAME 设为实例名（除非 env 文件已指定）。
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$REPO/.runtime-state"

NAME="${2:-}"
if [ -n "$NAME" ]; then
  BASE="node-$NAME"
else
  BASE="node"
fi
PID_FILE="$STATE_DIR/$BASE.pid"
LOG_FILE="$STATE_DIR/$BASE.log"
ENV_FILE="$STATE_DIR/$BASE.env"

# 加载实例 env 文件（文件不存在则跳过）
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
# 命名实例：未显式指定节点名时，用实例名作为节点名；状态目录独立避免 nodeId 冲突
if [ -n "$NAME" ]; then
  if [ -z "${LINKAGENT_NODE_NAME:-}" ]; then
    export LINKAGENT_NODE_NAME="$NAME"
  fi
  export LINKAGENT_NODE_STATE_DIR="$STATE_DIR/node-$NAME"
fi

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

write_pid() {
  mkdir -p "$STATE_DIR"
  echo "$1" >"$PID_FILE"
}

# 递归杀整棵进程树（pnpm → tsx → node）。不依赖进程组，兼容 macOS bash 3.2
kill_tree() {
  local sig="$1" pid="$2" child
  # 先递归杀子进程，再杀自身
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  kill "-$sig" "$pid" 2>/dev/null
}

pid_alive() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

do_start() {
  if is_running; then
    echo "节点 ${NAME:-default} 已在运行 (pid $(cat "$PID_FILE"))"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  echo "→ 后台启动节点 ${NAME:-default} ..."
  nohup pnpm --filter @linkagent/backend node:connect >>"$LOG_FILE" 2>&1 &
  write_pid "$!"
  sleep 1
  if is_running; then
    echo "✅ 节点 ${NAME:-default} 已启动 (pid $(cat "$PID_FILE")，日志 ${LOG_FILE})"
    return 0
  fi
  echo "⚠️  节点启动失败，最近日志："
  tail -n 15 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  return 1
}

do_stop() {
  if ! is_running; then
    echo "节点 ${NAME:-default} 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill_tree TERM "$pid"
  for _ in $(seq 1 10); do
    is_running || break
    sleep 1
  done
  is_running && kill_tree KILL "$pid"
  rm -f "$PID_FILE"
  echo "节点 ${NAME:-default} 已停止"
}

do_status() {
  if [ -n "$NAME" ]; then
    if is_running; then
      echo "节点 $NAME 运行中 pid=$(cat "$PID_FILE")  日志 $LOG_FILE"
    else
      echo "节点 $NAME 未运行"
    fi
    return 0
  fi
  # 不带实例名：汇总全部实例
  local found=0
  for f in "$STATE_DIR"/node*.pid; do
    [ -e "$f" ] || continue
    found=1
    local n p
    n="$(basename "$f" .pid)"
    p="$(cat "$f" 2>/dev/null)"
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "运行中  $n  pid=$p"
    else
      echo "已停止  $n（残留 pid 文件）"
    fi
  done
  [ "$found" = 0 ] && echo "无节点实例（.runtime-state 下无 pid 文件）"
  return 0
}

do_log() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "暂无日志（节点 ${NAME:-default} 尚未启动过）"
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
    echo "→ 前台运行节点 ${NAME:-default}（Ctrl-C 停止）..."
    cd "$REPO" && exec pnpm --filter @linkagent/backend node:connect
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|foreground} [name]"
    exit 1
    ;;
esac
