#!/usr/bin/env bash
# 网关机标准升级：git 同步 → build:dist → install 到 target，不覆盖已有 config / .runtime-state。
#
#   git clone <repo> /root/agent-linker    # 首次
#   cd /root/agent-linker && bash scripts/server-update.sh --restart
#
#   bash scripts/server-update.sh [--restart] [--skip-install] [--no-pull]
#   LINKAGENT_TARGET=/path/to/dist/linkagent  覆盖默认 $REPO/dist/linkagent
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${LINKAGENT_TARGET:-$ROOT/dist/linkagent}"
DIST="$(cd "$TARGET" 2>/dev/null && pwd || echo "$TARGET")"
STATE="$DIST/.runtime-state"
DIST_CFG="$DIST/config"
RESTART=0
SKIP_INSTALL=0
NO_PULL=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --no-pull) NO_PULL=1 ;;
    -h|--help)
      cat <<EOF
用法: $0 [--restart] [--skip-install] [--no-pull]

  git pull（仓库内）→ pnpm install → build:dist → 安装到 LINKAGENT_TARGET（默认 dist/linkagent）
  升级前备份 target 内 config/ 与 .runtime-state/，构建完成后原样恢复（不覆盖线上配置）。

环境变量:
  LINKAGENT_TARGET   部署目录（须含或即将生成 .linkagent-root）
EOF
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

if [ "$NO_PULL" = 0 ] && [ -d "$ROOT/.git" ]; then
  echo "→ git pull --ff-only"
  git pull --ff-only
elif [ "$NO_PULL" = 0 ]; then
  echo "→ 非 git 仓库，跳过 pull（首次请 git clone 后再执行）"
fi

# legacy 配置迁到仓库 config/（可选；dist 内 config 以备份恢复为准）
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

PNPM="${PNPM:-pnpm}"
if ! command -v "$PNPM" >/dev/null 2>&1; then
  if [ -x "${HOME}/.local/share/pnpm/pnpm" ]; then
    PNPM="${HOME}/.local/share/pnpm/pnpm"
  else
    echo "未找到 pnpm（仅构建 monorepo 需要；target 内 npm install 由 build:dist 执行）" >&2
    exit 1
  fi
fi

echo "→ pnpm install（monorepo 构建依赖）"
"$PNPM" install

BACKUP=""
if [ -d "$DIST_CFG" ] || [ -d "$STATE" ]; then
  BACKUP="$(mktemp -d)"
  if [ -d "$DIST_CFG" ]; then
    cp -a "$DIST_CFG" "$BACKUP/config"
    echo "→ 已备份 $DIST_CFG"
  fi
  if [ -d "$STATE" ]; then
    cp -a "$STATE" "$BACKUP/runtime-state"
    echo "→ 已备份 $STATE"
  fi
fi

BUILD_OUT="$ROOT/dist/linkagent"
if [ "$SKIP_INSTALL" = 1 ]; then
  echo "→ pnpm build:dist --skip-install"
  "$PNPM" build:dist -- --skip-install
else
  echo "→ pnpm build:dist（install 到 $BUILD_OUT）"
  "$PNPM" build:dist
fi

# 自定义 LINKAGENT_TARGET 时，将默认构建产物同步到 target（保留 target 内 node_modules 若已存在）
if [ "$(cd "$BUILD_OUT" 2>/dev/null && pwd)" != "$(cd "$DIST" 2>/dev/null && pwd)" ]; then
  echo "→ 同步构建产物 → $DIST"
  mkdir -p "$DIST"
  for entry in "$BUILD_OUT"/*; do
    base="$(basename "$entry")"
    if [ "$base" = "node_modules" ] && [ -d "$DIST/node_modules" ]; then
      continue
    fi
    rm -rf "$DIST/$base"
    cp -a "$entry" "$DIST/$base"
  done
fi

TEMPLATES_STASH=""
if [ -d "$DIST_CFG" ]; then
  TEMPLATES_STASH="$(mktemp -d)"
  for t in "$DIST_CFG"/*.template; do
    [ -f "$t" ] || continue
    cp -a "$t" "$TEMPLATES_STASH/"
  done
fi

if [ -n "$BACKUP" ]; then
  if [ -d "$BACKUP/config" ]; then
    rm -rf "$DIST_CFG"
    cp -a "$BACKUP/config" "$DIST_CFG"
    echo "→ 已恢复 $DIST_CFG（未覆盖线上 yaml）"
  fi
  if [ -d "$BACKUP/runtime-state" ]; then
    rm -rf "$STATE"
    cp -a "$BACKUP/runtime-state" "$STATE"
    echo "→ 已恢复 $STATE"
  fi
  rm -rf "$BACKUP"
fi

if [ -n "$TEMPLATES_STASH" ]; then
  for t in "$TEMPLATES_STASH"/*; do
    [ -f "$t" ] || continue
    cp -a "$t" "$DIST_CFG/$(basename "$t")"
  done
  rm -rf "$TEMPLATES_STASH"
  echo "→ 已更新 config/*.template（yaml 仍保留）"
fi

touch "$ROOT/.linkagent-server"
echo "✅ 安装目标：$DIST"
echo "   配置：$DIST_CFG/*.yaml（升级不覆盖；改配置后 ./start.sh restart）"
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
