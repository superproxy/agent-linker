#!/usr/bin/env bash
# 网关机：git 拉源码 → build:dist → 保留 dist/.runtime-state（配置由 server/config 打进 dist）。
#   scripts/server-update.sh              构建并 npm install
#   scripts/server-update.sh --restart    同上，完成后在 dist 里 restart gateway
#   scripts/server-update.sh --skip-install  只 build:dist，不跑 npm install
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

# 统一配置目录：仓库根 server/config（与 dist 内路径一致）
REPO_CFG="$ROOT/server/config"
LEGACY_CFG="$ROOT/backend/config"
mkdir -p "$REPO_CFG"
for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
  if [ ! -f "$REPO_CFG/$f" ] && [ -f "$LEGACY_CFG/$f" ]; then
    cp -a "$LEGACY_CFG/$f" "$REPO_CFG/$f"
    echo "→ 已迁移 legacy 配置：backend/config/$f → server/config/$f"
  fi
done
if [ ! -d "$REPO_CFG/pi-agent" ] && [ -d "$LEGACY_CFG/pi-agent" ]; then
  cp -a "$LEGACY_CFG/pi-agent" "$REPO_CFG/pi-agent"
  echo "→ 已迁移 pi-agent 模板目录到 server/config/pi-agent"
fi
if [ ! -f "$REPO_CFG/gateway.yaml" ]; then
  echo "→ 未找到 server/config/gateway.yaml，从模板初始化"
  node "$ROOT/scripts/config-init.mjs" || true
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

# legacy：仓库根 .runtime-state/edge 合并进 dist（仅当 dist 已有或即将生成）
REPO_EDGE="$ROOT/.runtime-state/edge"
if [ -d "$REPO_EDGE" ]; then
  mkdir -p "$STATE/edge"
  cp -a "$REPO_EDGE/." "$STATE/edge/"
  echo "→ 已合并仓库根 .runtime-state/edge → dist/.runtime-state/edge（建议以后只维护 dist 内 edge）"
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
echo "   配置：编辑 $ROOT/server/config/*.yaml 后重新执行本脚本（build 会写入 dist/server/config）"
echo "   运行：cd $DIST && ./start.sh restart gateway"
echo "   或：pnpm pm restart gateway（.linkagent-server 下与 dist 同安装根）"

if [ "$RESTART" = 1 ]; then
  if [ -f "$DIST/start.sh" ]; then
    echo "→ dist 内 restart gateway"
    (cd "$DIST" && ./start.sh restart gateway)
  else
    echo "→ pnpm pm restart gateway"
    "$PNPM" pm restart gateway
  fi
fi
