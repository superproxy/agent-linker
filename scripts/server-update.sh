#!/usr/bin/env bash
# 网关机：git 拉源码 → build:dist → 保留 dist/.runtime-state（配置由 config/ 打进 dist）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist/linkagent"
STATE="$DIST/.runtime-state"
RESTART=0
SKIP_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      echo "用法: $0 [--restart] [--skip-install]"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT"
# shellcheck source=lib/install-root.sh
. "$ROOT/scripts/lib/install-root.sh"

echo "→ git pull --ff-only"
git pull --ff-only

if [ -f "$DIST/.linkagent-root" ]; then
  touch "$ROOT/.linkagent-server"
fi

REPO_CFG="$ROOT/config"
LEGACY_SERVER_CFG="$ROOT/server/config"
LEGACY_CFG="$ROOT/backend/config"
mkdir -p "$REPO_CFG"
for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
  if [ ! -f "$REPO_CFG/$f" ] && [ -f "$LEGACY_SERVER_CFG/$f" ]; then
    cp -a "$LEGACY_SERVER_CFG/$f" "$REPO_CFG/$f"
    echo "→ 已迁移：server/config/$f → config/$f"
  fi
  if [ ! -f "$REPO_CFG/$f" ] && [ -f "$LEGACY_CFG/$f" ]; then
    cp -a "$LEGACY_CFG/$f" "$REPO_CFG/$f"
    echo "→ 已迁移：backend/config/$f → config/$f"
  fi
done
if [ ! -d "$REPO_CFG/pi-agent" ] && [ -d "$LEGACY_SERVER_CFG/pi-agent" ]; then
  cp -a "$LEGACY_SERVER_CFG/pi-agent" "$REPO_CFG/pi-agent"
elif [ ! -d "$REPO_CFG/pi-agent" ] && [ -d "$LEGACY_CFG/pi-agent" ]; then
  cp -a "$LEGACY_CFG/pi-agent" "$REPO_CFG/pi-agent"
fi
if [ ! -f "$REPO_CFG/gateway.yaml" ]; then
  echo "→ 未找到仓库 config/gateway.yaml（build:dist 仍会从模板写入 dist/config/）"
fi

PNPM="${PNPM:-pnpm}"
if ! command -v "$PNPM" >/dev/null 2>&1; then
  if [ -x "${HOME}/.local/share/pnpm/pnpm" ]; then
    PNPM="${HOME}/.local/share/pnpm/pnpm"
  else
    echo "未找到 pnpm" >&2
    exit 1
  fi
fi

echo "→ pnpm install（构建用）"
"$PNPM" install

REPO_EDGE="$ROOT/.runtime-state/edge"
if [ -d "$REPO_EDGE" ]; then
  mkdir -p "$STATE/edge"
  cp -a "$REPO_EDGE/." "$STATE/edge/"
  echo "→ 已合并仓库根 .runtime-state/edge → dist/.runtime-state/edge"
fi

BACKUP=""
if [ -d "$STATE" ]; then
  BACKUP="$(mktemp -d)"
  cp -a "$STATE" "$BACKUP/runtime-state"
  echo "→ 已备份 dist/.runtime-state（$BACKUP）"
fi

if [ "$SKIP_INSTALL" = 1 ]; then
  echo "→ pnpm build:dist --skip-install"
  "$PNPM" build:dist -- --skip-install
else
  echo "→ pnpm build:dist"
  "$PNPM" build:dist
fi

if [ -n "$BACKUP" ] && [ -d "$BACKUP/runtime-state" ]; then
  rm -rf "$STATE"
  cp -a "$BACKUP/runtime-state" "$STATE"
  echo "→ 已恢复 dist/.runtime-state"
  rm -rf "$BACKUP"
fi

touch "$ROOT/.linkagent-server"
echo "✅ 部署包已更新：$DIST"
echo "   配置：编辑 $ROOT/config/*.yaml 后重新执行本脚本"
echo "   运行：cd $DIST && ./start.sh restart gateway"

if [ "$RESTART" = 1 ]; then
  if [ -f "$DIST/start.sh" ]; then
    echo "→ dist 内 restart gateway"
    (cd "$DIST" && ./start.sh restart gateway)
  else
    echo "→ pnpm pm restart gateway"
    "$PNPM" pm restart gateway
  fi
fi
