#!/usr/bin/env bash
echo "提示：请用 migrate-server-from-legacy.sh（先仓库整理，再 /opt）" >&2
exec "$(cd "$(dirname "$0")" && pwd)/migrate-server-from-legacy.sh" "$@"
