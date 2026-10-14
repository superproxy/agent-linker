#!/usr/bin/env bash
exec bash "$(cd "$(dirname "$0")" && pwd)/edge-server-ctl.sh" "$@"
