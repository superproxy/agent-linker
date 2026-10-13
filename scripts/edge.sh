#!/usr/bin/env bash
# 兼容文档：转发 edge-server-ctl.sh
exec "$(cd "$(dirname "$0")" && pwd)/edge-server-ctl.sh" "$@"
