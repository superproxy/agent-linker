#!/usr/bin/env bash
# 运行安装根：在含 bin/、config/ 的目录执行运维脚本即可（*-ctl.sh 用 scripts/ 的上级，不查 env/标记文件）。
# 本文件仅保留给仍 source 它的旧脚本；新逻辑请勿再扩展「查找安装根」。

linkagent_install_root() {
  if [ -n "${1:-}" ]; then
    cd "$1" && pwd
    return
  fi
  pwd
}
