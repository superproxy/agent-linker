#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
CMD="${1:-start}"
exec node ctl.mjs "$CMD"
