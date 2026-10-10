#!/usr/bin/env bash
# 从模板生成 <安装根>/config/*.yaml（不依赖 pnpm，仅需 node + bash）。
#   bash scripts/config-init.sh [--force]
# 安装根：LINKAGENT_HOME，或含 .linkagent-root / pnpm-workspace.yaml 的目录。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# 独立包：scripts/ 的上级即安装根（含 .linkagent-root）
if [ -z "${LINKAGENT_HOME:-}" ] && [ -f "$DIR/../.linkagent-root" ]; then
  export LINKAGENT_HOME="$(cd "$DIR/.." && pwd)"
fi
exec node "$DIR/config-init.mjs" "$@"
