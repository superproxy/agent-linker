#!/usr/bin/env bash
# 本机 enhance 单机模式（edge 增强 + PM node + code-server + 宿主机 frpc）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-start}"
export LINKAGENT_LOCAL_STACK_ENHANCE=1
case "$CMD" in
  stop|status) exec node "$ROOT/scripts/local-stack-ctl.mjs" "$CMD" "${@:2}" ;;
  restart) exec node "$ROOT/scripts/local-stack-ctl.mjs" restart:enhance "${@:2}" ;;
  *) exec node "$ROOT/scripts/local-stack-ctl.mjs" "${CMD}:enhance" "${@:2}" ;;
esac
