#!/usr/bin/env bash
# 服务器从旧布局（如在 dist/linkagent 内运行）迁出 — 必须两步，不可跳过：
#   1) migrate-config         在 clone 目录合并 config（+ --with-runtime 运行态）
#   2) migrate-install-config 再复制到 LINKAGENT_INSTALL（默认 /opt/agent-linker）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${LINKAGENT_INSTALL:-/opt/agent-linker}"
LEGACY="${LINKAGENT_LEGACY_ROOT:-$ROOT/dist/linkagent}"

echo "==> 1/2 配置迁移（仓库根，含运行态）"
LINKAGENT_LEGACY_ROOT="$LEGACY" bash "$ROOT/scripts/migrate-config.sh" --with-runtime

echo ""
echo "==> 2/2 配置迁到安装目录 → $INSTALL"
LINKAGENT_INSTALL="$INSTALL" LINKAGENT_LEGACY_ROOT="" bash "$ROOT/scripts/migrate-install-config.sh" --with-runtime

echo ""
echo "✅ 两步迁移完成。下一步：bash scripts/server-install-update.sh --restart"
