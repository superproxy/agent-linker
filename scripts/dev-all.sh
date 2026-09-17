#!/usr/bin/env bash
# 一键联调：前台同时启动网关 + 一个节点，Ctrl-C 一起退出
#   scripts/dev-all.sh [节点实例名]
# 若网关已在 8787 运行（健康检查通过）则复用，不重复启动、退出时也不停止它。
# 节点配置同 scripts/node.sh：环境变量或 .runtime-state/node[-<name>].env。
# 注意：两进程日志直接输出到当前终端（节点日志自带 [node] 前缀，网关日志可按时间区分）。
set -u
# 后台启动时 SIGINT 可能被 shell 置为忽略，显式恢复以保证 Ctrl-C 能触发 cleanup
trap - INT

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$REPO/.runtime-state"
HOST_URL="http://127.0.0.1:8787"

NAME="${1:-}"
ENV_FILE="$STATE_DIR/node.env"
[ -n "$NAME" ] && ENV_FILE="$STATE_DIR/node-$NAME.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -n "$NAME" ]; then
  if [ -z "${LINKAGENT_NODE_NAME:-}" ]; then
    export LINKAGENT_NODE_NAME="$NAME"
  fi
  export LINKAGENT_NODE_STATE_DIR="$STATE_DIR/node-$NAME"
fi

GW_PID=""
NODE_PID=""
GW_STARTED=0

# 递归杀整棵进程树（pnpm → tsx → node），不依赖进程组，兼容 macOS bash 3.2
kill_tree() {
  local sig="$1" pid="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  kill "-$sig" "$pid" 2>/dev/null
}

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "→ 停止联调进程 ..."
  [ -n "$NODE_PID" ] && kill_tree TERM "$NODE_PID"
  if [ "$GW_STARTED" = 1 ] && [ -n "$GW_PID" ]; then
    kill_tree TERM "$GW_PID"
  fi
  wait "$NODE_PID" 2>/dev/null
  [ "$GW_STARTED" = 1 ] && wait "$GW_PID" 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

if curl -sS -m 2 "$HOST_URL/healthz" >/dev/null 2>&1; then
  echo "ℹ️  网关已在运行（${HOST_URL}），复用现有实例"
else
  echo "→ 启动网关 ..."
  (cd "$REPO" && exec pnpm --filter @linkagent/backend start) &
  GW_PID=$!
  GW_STARTED=1
  for _ in $(seq 1 20); do
    curl -sS -m 2 "$HOST_URL/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "→ 启动节点 ${NAME:-default} ..."
(cd "$REPO" && exec pnpm --filter @linkagent/backend node:connect) &
NODE_PID=$!

wait
