#!/usr/bin/env bash
# 将发布包目录（含 .linkagent-root）同步到运行安装目录，保留已有 config / .runtime-state。
# 供 dist/install.sh 与 server-install-update.sh 共用。旧目录迁入请用 scripts/migrate-to-install.sh。

linkagent_default_install_dir() {
  echo "/opt/agent-linker"
}

# $1=发布包根 $2=安装根 $3=skip_npm(0|1)
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
      config|.runtime-state) continue ;;
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

  if [ "$skip_npm" = 0 ] || [ ! -d "$install/node_modules" ]; then
    echo "→ npm install --omit=dev（$install）"
    (cd "$install" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error)
  fi

  printf 'linkagent runtime install root\n' >"$install/.linkagent-root"
}
