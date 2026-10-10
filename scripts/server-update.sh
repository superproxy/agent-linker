#!/usr/bin/env bash
# 网关机：git 同步 → build（dist 仅构建产物）→ 安装到独立目录，不覆盖 config / .runtime-state。
#
#   git clone … /root/agent-linker && cd /root/agent-linker
#   bash scripts/server-update.sh --restart
#
#   dist/linkagent     = 发布/构建目录（可每次重建）
#   ../linkagent       = 默认运行安装目录（config、.runtime-state、bin 运行副本）
#   LINKAGENT_INSTALL  = 自定义安装目录绝对路径
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/dist/linkagent"
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

  git pull → pnpm install → build:dist（写入 $ROOT/dist/linkagent）
  再将 bin/web/scripts 等同步到安装目录（默认 $(dirname "$ROOT")/linkagent），
  保留安装目录内 config/ 与 .runtime-state/（账号登录态在此）。

环境变量:
  LINKAGENT_INSTALL   安装目录（默认 ../linkagent；写入 .linkagent-install）
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

INSTALL="$(linkagent_read_install_path "$ROOT")"
INSTALL_CFG="$INSTALL/config"
INSTALL_STATE="$INSTALL/.runtime-state"

if [ "$NO_PULL" = 0 ] && [ -d "$ROOT/.git" ]; then
  echo "→ git pull --ff-only"
  git pull --ff-only
fi

mkdir -p "$INSTALL" "$INSTALL_CFG" "$INSTALL_STATE"

migrate_config_into_install() {
  local dest="$1"
  shift
  local f src
  for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
    [ -f "$dest/$f" ] && continue
    for src in "$@"; do
      if [ -f "$src/$f" ]; then
        cp -a "$src/$f" "$dest/$f"
        echo "→ 配置迁入安装目录：$src/$f → $dest/$f"
        break
      fi
    done
  done
  if [ ! -d "$dest/pi-agent" ]; then
    for src in "$@"; do
      if [ -d "$src/pi-agent" ]; then
        cp -a "$src/pi-agent" "$dest/pi-agent"
        echo "→ pi-agent 迁入 $dest/pi-agent"
        break
      fi
    done
  fi
}

echo "→ 安装目录：$INSTALL（dist 仅为构建：$BUILD）"
migrate_config_into_install "$INSTALL_CFG" \
  "$ROOT/backend/config" \
  "$ROOT/config" \
  "$ROOT/server/config" \
  "$BUILD/config"

merge_legacy_runtime_state() {
  local dest="$INSTALL_STATE"
  mkdir -p "$dest"
  local src rel
  for src in "$BUILD/.runtime-state" "$ROOT/.runtime-state"; do
    [ -d "$src" ] || continue
    echo "→ 合并运行态：$src → $dest（保留安装目录已有数据）"
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      if [ ! -e "$dest/$rel" ]; then
        mkdir -p "$(dirname "$dest/$rel")"
        cp -a "$src/$rel" "$dest/$rel"
      fi
    done < <(cd "$src" && find . -mindepth 1 2>/dev/null)
  done
}

merge_legacy_runtime_state

PNPM="${PNPM:-pnpm}"
if ! command -v "$PNPM" >/dev/null 2>&1; then
  [ -x "${HOME}/.local/share/pnpm/pnpm" ] && PNPM="${HOME}/.local/share/pnpm/pnpm"
fi
if ! command -v "$PNPM" >/dev/null 2>&1; then
  echo "未找到 pnpm（构建 monorepo 需要）" >&2
  exit 1
fi

echo "→ pnpm install（monorepo）"
"$PNPM" install

if [ "$SKIP_INSTALL" = 1 ]; then
  echo "→ pnpm build:dist --skip-install"
  "$PNPM" build:dist -- --skip-install
else
  echo "→ pnpm build:dist → $BUILD"
  "$PNPM" build:dist
fi

if [ ! -f "$BUILD/.linkagent-root" ]; then
  echo "构建失败：缺少 $BUILD/.linkagent-root" >&2
  exit 1
fi

echo "→ 发布物安装到 $INSTALL（跳过 config、.runtime-state）"
for entry in "$BUILD"/*; do
  base="$(basename "$entry")"
  case "$base" in
    config|.runtime-state) continue ;;
    node_modules)
      if [ "$SKIP_INSTALL" = 1 ] && [ -d "$INSTALL/node_modules" ]; then
        continue
      fi
      ;;
  esac
  rm -rf "$INSTALL/$base"
  cp -a "$entry" "$INSTALL/$base"
done

# 仅补充缺失 yaml；刷新 template
migrate_config_into_install "$INSTALL_CFG" "$BUILD/config"
for t in "$BUILD/config"/*.template; do
  [ -f "$t" ] || continue
  cp -a "$t" "$INSTALL_CFG/$(basename "$t")"
done

if [ "$SKIP_INSTALL" = 0 ] || [ ! -d "$INSTALL/node_modules" ]; then
  echo "→ npm install --omit=dev（安装目录）"
  (cd "$INSTALL" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error)
fi

printf '%s\n' "$INSTALL" >"$ROOT/.linkagent-install"
touch "$ROOT/.linkagent-server"
printf 'linkagent runtime install root\n' >"$INSTALL/.linkagent-root"

echo "✅ 构建：$BUILD"
echo "✅ 安装：$INSTALL"
echo "   配置：$INSTALL_CFG（原 backend/config 等已迁入；升级不覆盖）"
echo "   运行态：$INSTALL_STATE（含登录账号）"
echo "   启动：cd $INSTALL && LINKAGENT_HOME=$INSTALL ./start.sh restart gateway"

if [ "$RESTART" = 1 ]; then
  if [ -f "$INSTALL/start.sh" ]; then
    echo "→ restart gateway"
    (cd "$INSTALL" && LINKAGENT_HOME="$INSTALL" ./start.sh restart gateway)
  else
    LINKAGENT_HOME="$INSTALL" "$PNPM" pm restart gateway
  fi
fi
