#!/usr/bin/env bash
# 兼容旧路径：scripts/deploy-server-install-update.sh
exec "$(cd "$(dirname "$0")" && pwd)/deploy-server-install-update.sh" "$@"
