#!/usr/bin/env bash
# frps 与 APISIX 启停。网关进程不拉起这两个进程。
#   scripts/edge.sh start|stop|restart|status|log|build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$ROOT/.runtime-state/edge"
COMPOSE_FILE="$ROOT/scripts/edge/docker-compose.yaml"
export LINKAGENT_EDGE_DIR="$RUNTIME"
FRPS_PID="$RUNTIME/frps.pid"
FRPS_LOG="$RUNTIME/frps.log"
APISIX_LOG="$RUNTIME/apisix.log"

prepare() {
  mkdir -p "$RUNTIME"
  local out
  if [ -f "$ROOT/server/edge.mjs" ]; then
    out="$(cd "$ROOT" && node server/edge.mjs)"
  else
    out="$(cd "$ROOT" && pnpm --silent --filter @linkagent/backend exec tsx src/gateway/edge/cli.ts)"
  fi
  FRPS_BIN=""
  FRPS_CONF=""
  COMPOSE_PROJECT="linkagent-edge"
  COMPOSE_BIN=""
  COMPOSE_STYLE="none"
  local line key val
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      frpsBin) FRPS_BIN="$val" ;;
      frpsConf) FRPS_CONF="$val" ;;
      composeProject) COMPOSE_PROJECT="$val" ;;
      composeBin) COMPOSE_BIN="$val" ;;
      composeStyle) COMPOSE_STYLE="$val" ;;
    esac
  done <<<"$out"
}

frps_running() {
  [ -f "$FRPS_PID" ] && kill -0 "$(cat "$FRPS_PID")" 2>/dev/null
}

compose_cmd() {
  if [ "$COMPOSE_STYLE" = "plugin" ]; then
    "$COMPOSE_BIN" compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
  elif [ "$COMPOSE_STYLE" = "standalone" ]; then
    "$COMPOSE_BIN" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
  else
    echo "未找到 docker compose 插件，也未找到 docker-compose。可安装 docker-compose-plugin，或单独安装 docker-compose。" >&2
    return 1
  fi
}

start_frps() {
  if [ -z "$FRPS_BIN" ] || [ ! -f "$FRPS_BIN" ]; then
    echo "未找到 frps：$FRPS_BIN" >&2
    return 1
  fi
  chmod +x "$FRPS_BIN" 2>/dev/null || true
  if frps_running; then
    echo "frps 已在运行 (pid $(cat "$FRPS_PID"))"
    return 0
  fi
  nohup "$FRPS_BIN" -c "$FRPS_CONF" >>"$FRPS_LOG" 2>&1 &
  echo $! >"$FRPS_PID"
  echo "frps 已启动 pid=$(cat "$FRPS_PID") 配置 $FRPS_CONF"
}

start_apisix() {
  if ! compose_cmd up -d 2>&1 | tee -a "$APISIX_LOG"; then
    echo "APISIX 启动失败，日志 $APISIX_LOG" >&2
    return 1
  fi
  echo "APISIX 已提交启动，日志 $APISIX_LOG"
}

build_apisix() {
  if [ ! -f "$ROOT/scripts/edge/Dockerfile" ]; then
    echo "缺少 $ROOT/scripts/edge/Dockerfile" >&2
    return 1
  fi
  echo "→ 构建镜像 linkagent-apisix:local"
  compose_cmd build apisix
}

stop_frps() {
  if ! frps_running; then
    rm -f "$FRPS_PID"
    echo "frps 未在运行"
    return 0
  fi
  kill "$(cat "$FRPS_PID")" 2>/dev/null || true
  rm -f "$FRPS_PID"
  echo "frps 已停止"
}

stop_apisix() {
  compose_cmd down >>"$APISIX_LOG" 2>&1
  echo "APISIX 已停止"
}

do_start() {
  prepare
  start_frps
  start_apisix
}

do_build() {
  prepare
  build_apisix
}

do_stop() {
  prepare
  stop_frps
  stop_apisix
}

do_status() {
  prepare
  if frps_running; then
    echo "frps 运行中 pid=$(cat "$FRPS_PID")"
  else
    echo "frps 未运行"
  fi
  compose_cmd ps || true
}

do_log() {
  touch "$FRPS_LOG" "$APISIX_LOG"
  tail -n 80 -f "$FRPS_LOG" "$APISIX_LOG"
}

case "${1:-start}" in
  start) do_start ;;
  build) do_build ;;
  stop) do_stop ;;
  restart) do_stop && do_start ;;
  status) do_status ;;
  log) do_log ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|build}"
    exit 1
    ;;
esac
