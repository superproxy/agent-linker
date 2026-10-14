#!/usr/bin/env bash
# 兼容旧名：转发 edge-server-ctl.sh
exec bash "$(cd "$(dirname "$0")" && pwd)/edge-server-ctl.sh" "$@"
