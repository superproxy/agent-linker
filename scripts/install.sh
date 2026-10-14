#!/usr/bin/env bash
# 兼容入口：请优先使用 scripts/deploy-install.sh（发布包内为 ./install.sh）
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy-install.sh" "$@"
