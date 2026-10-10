#!/bin/sh
# Docker 聚合入口：code-server / dev / VNC / frpc 仍走 linkagent-entrypoint.sh，node 同容器出站连网关。
set -u

export LINKAGENT_HOME="${LINKAGENT_HOME:-/opt/linkagent-node}"
export LINKAGENT_NODE_SERVE_WEB=0
export LINKAGENT_NODE_STATE_DIR="${LINKAGENT_NODE_STATE_DIR:-/var/lib/linkagent/node}"
export LINKAGENT_NODE_AGENTS="${LINKAGENT_NODE_AGENTS:-pi}"
mkdir -p "$LINKAGENT_NODE_STATE_DIR" /etc/linkagent
# 与主机模式相同：node 写入 frpc.toml，本入口只负责执行 frpc。文件在容器内，不再挂载。
export LINKAGENT_FRPC_BY_NODE=1

if [ ! -f /root/.pi/agent/models.json ]; then
  node "$LINKAGENT_HOME/scripts/setup-pi.mjs" --skip-install || true
fi

/usr/local/bin/linkagent-entrypoint.sh "$@" &
entry_pid=$!

(
  cd "${LINKAGENT_NODE_WORKSPACE:-/root/workspace}" || exit 1
  if [ -f "$LINKAGENT_HOME/bin/node.mjs" ]; then
    exec node "$LINKAGENT_HOME/bin/node.mjs"
  fi
  exec node "$LINKAGENT_HOME/server/node.mjs"
) &
node_pid=$!

shutdown() {
  kill "$node_pid" "$entry_pid" 2>/dev/null || true
  wait
  exit 0
}
trap shutdown INT TERM
wait
