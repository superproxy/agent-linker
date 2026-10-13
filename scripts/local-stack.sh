#!/usr/bin/env bash
# 本机完整栈（原生 PM：edge + gateway + channels + node），非 pnpm dev 源码模式
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-start}"
exec node "$ROOT/scripts/local-stack-ctl.mjs" "$CMD" "${@:2}"
