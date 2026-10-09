#!/bin/sh
# Docker 聚合入口：code-server / dev / VNC / frpc 仍走 linkagent-entrypoint.sh，node 同容器出站连网关。
set -u

export LINKAGENT_HOME="${LINKAGENT_HOME:-/opt/linkagent-node}"
export LINKAGENT_NODE_SERVE_WEB=0
export LINKAGENT_NODE_STATE_DIR="${LINKAGENT_NODE_STATE_DIR:-/var/lib/linkagent/node}"
export LINKAGENT_NODE_AGENTS="${LINKAGENT_NODE_AGENTS:-pi}"
mkdir -p "$LINKAGENT_NODE_STATE_DIR" /etc/linkagent

if [ -z "${FRPS_TOKEN:-}" ] && [ -n "${LINKAGENT_GATEWAY_TOKEN:-}" ]; then
  printf '%s\n' "[frpc] 使用节点 token 作为 FRPS_TOKEN"
  FRPS_TOKEN=$LINKAGENT_GATEWAY_TOKEN
  export FRPS_TOKEN
fi

if [ -f /etc/linkagent/frpc.toml ]; then
  printf '%s\n' "[frpc] 使用已挂载的 /etc/linkagent/frpc.toml"
elif [ -n "${FRPS_TOKEN:-}" ]; then
  node /usr/local/bin/linkagent-render-frpc.mjs || printf '%s\n' "[frpc] 生成配置失败"
else
  printf '%s\n' "[frpc] 未生成配置：没有 FRPS_TOKEN，也没有节点 token"
fi

if [ ! -f /root/.pi/agent/models.json ]; then
  node "$LINKAGENT_HOME/scripts/setup-pi.mjs" --skip-install || true
fi

/usr/local/bin/linkagent-entrypoint.sh "$@" &
entry_pid=$!

(
  cd "${LINKAGENT_NODE_WORKSPACE:-/root/workspace}" || exit 1
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
