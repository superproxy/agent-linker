#!/usr/bin/env bash
# 服务器从旧布局（如在 dist/linkagent 内运行）迁出 — 必须两步，不可跳过：
#   1) migrate-repo-layout  在 clone 目录合并 config / .runtime-state（开发=运行）
#   2) migrate-copy-install 再复制到 LINKAGENT_INSTALL（默认 /opt/agent-linker）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${LINKAGENT_INSTALL:-/opt/agent-linker}"
LEGACY="${LINKAGENT_LEGACY_ROOT:-$ROOT/dist/linkagent}"

echo "==> 1/2 开发/运行迁移（仓库根）"
LINKAGENT_LEGACY_ROOT="$LEGACY" bash "$ROOT/scripts/migrate-repo-layout.sh"

echo ""
echo "==> 2/2 目录切换 → $INSTALL"
LINKAGENT_INSTALL="$INSTALL" LINKAGENT_LEGACY_ROOT="" bash "$ROOT/scripts/migrate-copy-install.sh"

echo ""
echo "✅ 两步迁移完成。下一步：bash scripts/server-install-update.sh --restart"
