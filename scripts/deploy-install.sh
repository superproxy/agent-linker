#!/usr/bin/env bash
# Release 包安装：将当前目录（解压后的 linkagent 发布包）安装到运行目录。
#   ./install.sh
#   LINKAGENT_INSTALL=/opt/agent-linker ./install.sh
#   ./install.sh --restart
set -euo pipefail

linkagent_materialize_config_from_templates() {
  local dest="$1"
  local f
  mkdir -p "$dest"
  for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
    [ -f "$dest/$f" ] && continue
    if [ -f "$dest/$f.template" ]; then
      cp -a "$dest/$f.template" "$dest/$f"
      echo "→ 配置：由模板生成 $dest/$f"
    fi
  done
}

linkagent_sync_publish_to_install() {
  local package="$1"
  local install="$2"
  local skip_npm="${3:-0}"
  local install_cfg="$install/config"
  local install_state="$install/.runtime-state"

  if [ ! -f "$package/.linkagent-root" ]; then
    echo "不是 linkagent 发布包：缺少 $package/.linkagent-root" >&2
    return 1
  fi

  mkdir -p "$install" "$install_cfg" "$install_state"

  echo "→ 同步程序文件 → $install（不覆盖 config、.runtime-state）"
  local entry base
  for entry in "$package"/*; do
    base="$(basename "$entry")"
    case "$base" in
      config|.runtime-state|lib) continue ;;
      node_modules)
        if [ "$skip_npm" = 1 ] && [ -d "$install/node_modules" ]; then
          continue
        fi
        ;;
    esac
    rm -rf "$install/$base"
    cp -a "$entry" "$install/$base"
  done

  local t
  for t in "$package/config"/*.template; do
    [ -f "$t" ] || continue
    cp -a "$t" "$install_cfg/$(basename "$t")"
  done
  linkagent_materialize_config_from_templates "$install_cfg"

  if [ "$skip_npm" = 0 ] || [ ! -d "$install/node_modules" ]; then
    echo "→ npm install --omit=dev（$install）"
    (cd "$install" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error)
  fi

  printf 'linkagent runtime install root\n' >"$install/.linkagent-root"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.linkagent-root" ]; then
  PACKAGE="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../.linkagent-root" ]; then
  PACKAGE="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  PACKAGE="$SCRIPT_DIR"
fi

INSTALL="${LINKAGENT_INSTALL:-/opt/agent-linker}"
RESTART=0
SKIP_NPM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --restart) RESTART=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    --install-dir)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "缺少 --install-dir 后的路径" >&2
        exit 1
      fi
      INSTALL="$2"
      shift 2
      ;;
    --install-dir=*)
      INSTALL="${1#*=}"
      if [ -z "$INSTALL" ]; then
        echo "--install-dir= 需要非空路径" >&2
        exit 1
      fi
      shift
      ;;
    -h|--help)
      cat <<EOF
用法: $0 [--install-dir <path>] [--restart] [--skip-npm]

  从发布包（包根含 bin/、config/、.linkagent-root）安装到运行目录。
  请在发布包根执行 ./install.sh（勿用 scripts/ 下同名文件）。

  --install-dir <path>  目标目录（优先于环境变量 LINKAGENT_INSTALL）
  LINKAGENT_INSTALL     缺省 /opt/agent-linker

  不覆盖安装目录已有 config/*.yaml 与 .runtime-state/（含登录账号）。
  缺省 yaml 由 config/*.template 自动生成（仅当目标文件尚不存在）。
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      echo "提示: $0 --help" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$PACKAGE/.linkagent-root" ]; then
  echo "不是 linkagent 发布包：缺少 $PACKAGE/.linkagent-root" >&2
  if [ -f "$(dirname "$PACKAGE")/pnpm-workspace.yaml" ] || [ -f "$PACKAGE/pnpm-workspace.yaml" ]; then
    echo "提示：源码仓库请用 bash scripts/deploy-server-install-update.sh 或 pnpm local:install-update" >&2
  elif [ "$PACKAGE" != "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install.sh" ]; then
    echo "提示：请在发布包根目录执行 ./install.sh" >&2
  fi
  exit 1
fi

if [ "$(id -u)" -ne 0 ] && [ ! -w "$(dirname "$INSTALL")" ] 2>/dev/null; then
  echo "提示：安装到 $INSTALL 通常需要 root，或使用 LINKAGENT_INSTALL=~/agent-linker" >&2
fi

linkagent_sync_publish_to_install "$PACKAGE" "$INSTALL" "$SKIP_NPM"

echo "✅ 已安装到 $INSTALL"
echo "   配置：$INSTALL/config/"
echo "   边缘：cd $INSTALL && ./edge-ctl.sh start"
echo "   网关：cd $INSTALL && ./server-ctl.sh start"

if [ "$RESTART" = 1 ]; then
  (cd "$INSTALL" && ./server-ctl.sh restart gateway)
fi
