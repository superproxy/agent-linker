#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/migrate-install-config.mjs" "$@"
