#!/usr/bin/env bash
# Docker 聚合节点 linkagent-node
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/local-node-docker-ctl.mjs" "$@"
