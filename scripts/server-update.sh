#!/usr/bin/env bash
# 网关机：git 拉源码 → 打 dist → 安装依赖，保留已有 server/config 与 .runtime-state。
#   scripts/server-update.sh              构建并 npm install
#   scripts/server-update.sh --restart    同上，完成后在 dist 里 restart gateway
#   scripts/server-update.sh --skip-install  只 build:dist，不跑 npm install（增量依赖时自行 install）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist/linkagent"
CFG="$DIST/server/config"
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
echo "→ git pull --ff-only"
git pull --ff-only

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

# 旧布局：配置在仓库 backend/config、edge 在仓库根 .runtime-state/edge。
# dist 网关只读 dist/linkagent 下路径，构建前先并入 dist，避免仍改 agent-linker 根目录却不生效。
REPO_CFG="$ROOT/backend/config"
REPO_EDGE="$ROOT/.runtime-state/edge"
if [ -d "$REPO_CFG" ]; then
  mkdir -p "$CFG"
  for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
    if [ -f "$REPO_CFG/$f" ]; then
      cp -a "$REPO_CFG/$f" "$CFG/$f"
    fi
  done
  if [ -d "$REPO_CFG/pi-agent" ]; then
    rm -rf "$CFG/pi-agent"
    cp -a "$REPO_CFG/pi-agent" "$CFG/pi-agent"
  fi
  echo "→ 已把 backend/config 同步到 dist/server/config（线上请只改 dist 内 yaml）"
fi
if [ -d "$REPO_EDGE" ]; then
  mkdir -p "$STATE/edge"
  cp -a "$REPO_EDGE/." "$STATE/edge/"
  echo "→ 已把仓库根 .runtime-state/edge 合并到 dist/.runtime-state/edge"
fi

BACKUP=""
if [ -d "$CFG" ] || [ -d "$STATE" ]; then
  BACKUP="$(mktemp -d)"
  if [ -d "$CFG" ]; then
    mkdir -p "$BACKUP/config"
    for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
      if [ -f "$CFG/$f" ]; then
        cp -a "$CFG/$f" "$BACKUP/config/$f"
      fi
    done
    if [ -d "$CFG/pi-agent" ]; then
      cp -a "$CFG/pi-agent" "$BACKUP/config/pi-agent"
    fi
  fi
  if [ -d "$STATE" ]; then
    cp -a "$STATE" "$BACKUP/runtime-state"
  fi
  echo "→ 已备份 dist 内 server/config 与 .runtime-state（$BACKUP）"
fi

if [ "$SKIP_INSTALL" = 1 ]; then
  echo "→ pnpm build:dist --skip-install"
  "$PNPM" build:dist -- --skip-install
else
  echo "→ pnpm build:dist"
  "$PNPM" build:dist
fi

if [ -n "$BACKUP" ]; then
  if [ -d "$BACKUP/config" ]; then
    mkdir -p "$CFG"
    for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
      if [ -f "$BACKUP/config/$f" ]; then
        cp -a "$BACKUP/config/$f" "$CFG/$f"
      fi
    done
    if [ -d "$BACKUP/config/pi-agent" ]; then
      rm -rf "$CFG/pi-agent"
      cp -a "$BACKUP/config/pi-agent" "$CFG/pi-agent"
    fi
    echo "→ 已恢复 dist/server/config"
  fi
  if [ -d "$BACKUP/runtime-state" ]; then
    rm -rf "$STATE"
    cp -a "$BACKUP/runtime-state" "$STATE"
    echo "→ 已恢复 dist/.runtime-state"
  fi
  rm -rf "$BACKUP"
fi

echo "✅ 部署包已更新：$DIST"
echo "   运行：cd $DIST && ./start.sh restart gateway"
echo "   或仓库根：pnpm pm restart gateway（需 pm 指向 dist 布局）"

if [ "$RESTART" = 1 ]; then
  if [ -f "$DIST/start.sh" ]; then
    echo "→ dist 内 restart gateway"
    (cd "$DIST" && ./start.sh restart gateway)
  else
    echo "→ pnpm pm restart gateway"
    "$PNPM" pm restart gateway
  fi
fi
