#!/usr/bin/env bash
# 源码网关机：在 git clone 的仓库根执行 — 同步源码 → 构建 dist → 部署到运行安装目录。
# 与 Release 包 ./install.sh 不同：本脚本需要 pnpm monorepo，不负责迁入（见 migrate-repo-layout / migrate-copy-install）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/dist/linkagent"
RESTART=0
SKIP_DEPLOY_NPM=0
NO_PULL=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --skip-install|--skip-deploy-npm) SKIP_DEPLOY_NPM=1 ;;
    --no-pull) NO_PULL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      cat <<EOF
用法: $0 [--restart] [--no-pull] [--skip-build] [--skip-deploy-npm]

  在已 clone 的源码仓库（$ROOT）执行三步：

    1/3 同步源码   git pull --ff-only（--no-pull 跳过）
    2/3 构建       pnpm install && pnpm build:dist → $BUILD
    3/3 部署       发布包同步到 LINKAGENT_INSTALL（默认 /opt/agent-linker）

  首次从旧布局：bash scripts/migrate-server-from-legacy.sh（先 repo 再 LINKAGENT_INSTALL）

  --skip-build       仅部署（假定 dist/linkagent 已构建）
  --skip-deploy-npm  部署时不于安装目录执行 npm install
  --restart          部署后于安装目录 ./start.sh restart gateway
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
# shellcheck source=lib/sync-install.sh
. "$ROOT/scripts/lib/sync-install.sh"

INSTALL="${LINKAGENT_INSTALL:-$(linkagent_default_install_dir)}"
INSTALL_CFG="$INSTALL/config"
INSTALL_STATE="$INSTALL/.runtime-state"

mkdir -p "$INSTALL" "$INSTALL_CFG" "$INSTALL_STATE"

echo "==> 源码仓库：$ROOT"
echo "==> 构建产物：$BUILD"
echo "==> 部署目标：$INSTALL"

if [ ! -f "$INSTALL_CFG/gateway.yaml" ] && [ ! -d "$INSTALL_STATE/users" ]; then
  echo "提示：请先：bash scripts/migrate-server-from-legacy.sh" >&2
fi

PNPM="${PNPM:-pnpm}"
if ! command -v "$PNPM" >/dev/null 2>&1; then
  [ -x "${HOME}/.local/share/pnpm/pnpm" ] && PNPM="${HOME}/.local/share/pnpm/pnpm"
fi
if ! command -v "$PNPM" >/dev/null 2>&1; then
  echo "未找到 pnpm（源码机构建必需）" >&2
  exit 1
fi

echo ""
echo "==> 1/3 同步源码"
if [ "$NO_PULL" = 0 ] && [ -d "$ROOT/.git" ]; then
  git pull --ff-only
elif [ "$NO_PULL" = 1 ]; then
  echo "→ 跳过 git pull（--no-pull）"
else
  echo "→ 非 git 仓库，跳过 pull"
fi

if [ "$SKIP_BUILD" = 0 ]; then
  echo ""
  echo "==> 2/3 构建"
  echo "→ pnpm install（monorepo）"
  "$PNPM" install
  if [ "$SKIP_DEPLOY_NPM" = 1 ]; then
    echo "→ pnpm build:dist -- --skip-install"
    "$PNPM" build:dist -- --skip-install
  else
    echo "→ pnpm build:dist"
    "$PNPM" build:dist
  fi
else
  echo ""
  echo "==> 2/3 构建（跳过 --skip-build）"
  if [ ! -f "$BUILD/.linkagent-root" ]; then
    echo "缺少发布包：$BUILD（请先构建或去掉 --skip-build）" >&2
    exit 1
  fi
fi

echo ""
echo "==> 3/3 部署"
skip_npm=0
[ "$SKIP_DEPLOY_NPM" = 1 ] && skip_npm=1
linkagent_sync_publish_to_install "$BUILD" "$INSTALL" "$skip_npm"

printf '%s\n' "$INSTALL" >"$ROOT/.linkagent-install"
touch "$ROOT/.linkagent-server"

echo ""
echo "✅ 构建：$BUILD"
echo "✅ 部署：$INSTALL"

if [ "$RESTART" = 1 ]; then
  (cd "$INSTALL" && LINKAGENT_HOME="$INSTALL" ./start.sh restart gateway)
fi
