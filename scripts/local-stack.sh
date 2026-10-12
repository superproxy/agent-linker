#!/usr/bin/env bash
# 本机方案：edge + gateway + node
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
CMD="${1:-start}"
cd "$ROOT"
case "$CMD" in
  start)
    node "$DIR/edge-ctl.mjs" start
    node "$DIR/server-ctl.mjs" start
    pnpm --filter @linkagent/backend pm:restart node
    ;;
  stop)
    pnpm --filter @linkagent/backend pm:stop node
    node "$DIR/server-ctl.mjs" stop
    node "$DIR/edge-ctl.mjs" stop
    ;;
  restart) bash "$0" stop && bash "$0" start ;;
  status)
    echo "--- edge ---"
    node "$DIR/edge-ctl.mjs" status
    echo "--- gateway ---"
    node "$DIR/server-ctl.mjs" status
    echo "--- pm ---"
    pnpm --filter @linkagent/backend pm:status
    ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
