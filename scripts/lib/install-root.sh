#!/usr/bin/env bash
# 解析 linkagent 安装根（与 backend/src/install/layout.ts 一致）：
#   LINKAGENT_HOME  >  仓库根 .linkagent-server + dist/linkagent  >  monorepo 根
# 开发机勿创建 .linkagent-server；需强制 dev 时可 export LINKAGENT_DEV=1
linkagent_repo_root() {
  local here="$1"
  cd "$here" || exit 1
  while [ ! -f pnpm-workspace.yaml ]; do
    local parent
    parent="$(dirname "$(pwd)")"
    if [ "$parent" = "$(pwd)" ]; then
      pwd
      return
    fi
    cd "$parent" || exit 1
  done
  pwd
}

linkagent_install_root() {
  local repo="${1:-}"
  if [ -z "$repo" ]; then
    local lib_dir
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo="$(linkagent_repo_root "$(cd "$lib_dir/../.." && pwd)")"
  fi
  if [ -n "${LINKAGENT_HOME:-}" ]; then
    cd "$LINKAGENT_HOME" && pwd
    return
  fi
  if [ "${LINKAGENT_DEV:-}" = "1" ]; then
    echo "$repo"
    return
  fi
  local dist="$repo/dist/linkagent"
  if [ -f "$repo/.linkagent-server" ] && [ -f "$dist/.linkagent-root" ]; then
    cd "$dist" && pwd
    return
  fi
  echo "$repo"
}
