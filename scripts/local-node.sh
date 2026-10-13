#!/usr/bin/env bash
# 本机纯节点（仅 PM 原生 node 连接器）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/local-node-ctl.mjs" "$@"
