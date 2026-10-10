#!/usr/bin/env bash
# 一次性迁入：旧目录 config / .runtime-state → 运行安装目录。
# 由 migrate-repo-layout / migrate-copy-install 使用，不打包进 dist。

linkagent_migrate_config_into() {
  local dest="$1"
  shift
  local f src
  mkdir -p "$dest"
  for f in gateway.yaml weixin.yaml channels.yaml node.yaml; do
    [ -f "$dest/$f" ] && continue
    for src in "$@"; do
      [ -n "$src" ] || continue
      if [ -f "$src/$f" ]; then
        cp -a "$src/$f" "$dest/$f"
        echo "→ 配置：$src/$f → $dest/$f"
        break
      fi
    done
  done
  if [ ! -d "$dest/pi-agent" ]; then
    for src in "$@"; do
      [ -n "$src" ] || continue
      if [ -d "$src/pi-agent" ]; then
        cp -a "$src/pi-agent" "$dest/pi-agent"
        echo "→ 配置：$src/pi-agent → $dest/pi-agent"
        break
      fi
    done
  fi
}

# 合并运行态：仅当目标路径不存在时复制（不覆盖已有登录态等）
linkagent_merge_runtime_into() {
  local dest="$1"
  shift
  mkdir -p "$dest"
  local src rel
  for src in "$@"; do
    [ -d "$src" ] || continue
    echo "→ 合并运行态：$src → $dest"
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      if [ ! -e "$dest/$rel" ]; then
        mkdir -p "$(dirname "$dest/$rel")"
        cp -a "$src/$rel" "$dest/$rel"
      fi
    done < <(cd "$src" && find . -mindepth 1 2>/dev/null)
  done
}
