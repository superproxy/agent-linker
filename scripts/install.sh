#!/usr/bin/env bash
# Release 包安装：将当前目录（解压后的 linkagent 发布包）安装到运行目录。
#   ./install.sh
#   LINKAGENT_INSTALL=/opt/agent-linker ./install.sh
#   ./install.sh --restart
set -euo pipefail

PACKAGE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="${LINKAGENT_INSTALL:-/opt/agent-linker}"
RESTART=0
SKIP_NPM=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    -h|--help)
      cat <<EOF
用法: $0 [--restart] [--skip-npm]

  从发布包（当前目录，含 bin/ config/ .linkagent-root）安装到：
    LINKAGENT_INSTALL（默认 /opt/agent-linker）

  不覆盖安装目录已有 config/*.yaml 与 .runtime-state/（含登录账号）。
  从旧目录迁入配置/登录态：在源码仓库执行 bash scripts/migrate-to-install.sh（一次性，不随本脚本执行）。
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

# shellcheck source=lib/sync-install.sh
. "$PACKAGE/scripts/lib/sync-install.sh"

if [ "$(id -u)" -ne 0 ] && [ ! -w "$(dirname "$INSTALL")" ] 2>/dev/null; then
  echo "提示：安装到 $INSTALL 通常需要 root，或使用 LINKAGENT_INSTALL=~/agent-linker" >&2
fi

linkagent_sync_publish_to_install "$PACKAGE" "$INSTALL" "$SKIP_NPM"

echo "✅ 已安装到 $INSTALL"
echo "   配置：$INSTALL/config/"
echo "   启动：cd $INSTALL && LINKAGENT_HOME=$INSTALL ./start.sh start"

if [ "$RESTART" = 1 ]; then
  (cd "$INSTALL" && LINKAGENT_HOME="$INSTALL" ./start.sh restart gateway)
fi
