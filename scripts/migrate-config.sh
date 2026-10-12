#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/migrate-config.mjs" "$@"
