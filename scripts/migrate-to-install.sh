#!/usr/bin/env bash
# 一次性迁移：从旧布局把 config 与 .runtime-state 迁入运行安装目录。
# 独立执行，不参与 pnpm build:dist / install.sh / server-install-update.sh。
#
#   bash scripts/migrate-to-install.sh
#   LINKAGENT_INSTALL=/opt/agent-linker bash scripts/migrate-to-install.sh
#   bash scripts/migrate-to-install.sh --dry-run
#
# 可选环境变量：
#   LINKAGENT_LEGACY_ROOT   旧「整包运行目录」（如曾在 dist/linkagent 或 /root/linkagent 直接跑）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${LINKAGENT_INSTALL:-/opt/agent-linker}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<EOF
用法: $0 [--dry-run]

  将下列来源中**尚未存在于** $INSTALL 的配置与运行态迁入安装目录（缺项才复制，不覆盖已有文件）：

  配置候选（按顺序，每个 yaml 只取第一个命中）：
    backend/config、config/、server/config/、dist/linkagent/config/
    以及 LINKAGENT_LEGACY_ROOT/config（若设置）

  运行态合并：
    dist/linkagent/.runtime-state、仓库根 .runtime-state/
    以及 LINKAGENT_LEGACY_ROOT/.runtime-state（若设置）

  迁入完成后请用 install.sh（Release）或 server-install-update.sh（源码网关机）部署程序。

  LINKAGENT_INSTALL（默认 /opt/agent-linker）
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（额外路径请用 LINKAGENT_LEGACY_ROOT）" >&2
      exit 1
      ;;
  esac
done

# shellcheck source=lib/migrate-install.sh
. "$ROOT/scripts/lib/migrate-install.sh"

INSTALL_CFG="$INSTALL/config"
INSTALL_STATE="$INSTALL/.runtime-state"

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] 安装目录：$INSTALL"
  echo "[dry-run] 将检查并复制缺失的 gateway/weixin/channels/node.yaml 与 .runtime-state 子路径"
  exit 0
fi

mkdir -p "$INSTALL" "$INSTALL_CFG" "$INSTALL_STATE"

CONFIG_SOURCES=()
for d in \
  "$ROOT/backend/config" \
  "$ROOT/config" \
  "$ROOT/server/config" \
  "$ROOT/dist/linkagent/config"; do
  [ -d "$d" ] && CONFIG_SOURCES+=("$d")
done
if [ -n "${LINKAGENT_LEGACY_ROOT:-}" ] && [ -d "$LINKAGENT_LEGACY_ROOT/config" ]; then
  CONFIG_SOURCES+=("$LINKAGENT_LEGACY_ROOT/config")
fi

if [ "${#CONFIG_SOURCES[@]}" -gt 0 ]; then
  linkagent_migrate_config_into "$INSTALL_CFG" "${CONFIG_SOURCES[@]}"
else
  echo "→ 未找到可迁入的配置目录（可设置 LINKAGENT_LEGACY_ROOT）"
fi

RUNTIME_SOURCES=()
for d in "$ROOT/dist/linkagent/.runtime-state" "$ROOT/.runtime-state"; do
  [ -d "$d" ] && RUNTIME_SOURCES+=("$d")
done
if [ -n "${LINKAGENT_LEGACY_ROOT:-}" ] && [ -d "$LINKAGENT_LEGACY_ROOT/.runtime-state" ]; then
  RUNTIME_SOURCES+=("$LINKAGENT_LEGACY_ROOT/.runtime-state")
fi

if [ "${#RUNTIME_SOURCES[@]}" -gt 0 ]; then
  linkagent_merge_runtime_into "$INSTALL_STATE" "${RUNTIME_SOURCES[@]}"
else
  echo "→ 未找到可合并的 .runtime-state"
fi

printf '%s\n' "$INSTALL" >"$ROOT/.linkagent-install"
touch "$ROOT/.linkagent-server"

echo "✅ 已迁入 $INSTALL"
echo "   下一步：bash scripts/server-install-update.sh --restart"
echo "   或 Release：sudo ./install.sh --restart（在发布包目录）"
