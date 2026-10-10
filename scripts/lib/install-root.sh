#!/usr/bin/env bash
# 解析 linkagent 运行安装根（与 backend/src/install/layout.ts 一致）：
#   LINKAGENT_HOME / LINKAGENT_INSTALL  >  .linkagent-install  >  <repo>/../linkagent  >  legacy dist
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

linkagent_default_install() {
  local repo="$1"
  echo "$(dirname "$repo")/linkagent"
}

linkagent_read_install_path() {
  local repo="$1"
  if [ -n "${LINKAGENT_INSTALL:-}" ]; then
    echo "$(cd "$LINKAGENT_INSTALL" && pwd)"
    return
  fi
  if [ -f "$repo/.linkagent-install" ]; then
    local line
    line="$(head -n1 "$repo/.linkagent-install" | tr -d '\r')"
    if [ -n "$line" ]; then
      echo "$(cd "$line" && pwd)"
      return
    fi
  fi
  linkagent_default_install "$repo"
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
  if [ -f "$repo/.linkagent-server" ]; then
    linkagent_read_install_path "$repo"
    return
  fi
  echo "$repo"
}
