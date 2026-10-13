#!/usr/bin/env bash
# 默认原生；start:enhance = edge + code-server 增强
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
CMD="${1:-start}"
ENHANCE=0
ENHANCE_DOCKER=0
if [[ "$CMD" == *:enhance:docker ]]; then
  ENHANCE_DOCKER=1
  CMD="${CMD%:enhance:docker}"
elif [[ "$CMD" == *:enhance ]]; then
  ENHANCE=1
  CMD="${CMD%:enhance}"
fi
if [[ "$CMD" == "enhance:docker" ]]; then CMD=start; ENHANCE_DOCKER=1; fi
if [[ "$CMD" == "enhance" ]]; then CMD=start; ENHANCE=1; fi
cd "$ROOT"

local_stack_frp_env() {
  if [[ "${ENHANCE_DOCKER:-0}" == "1" ]]; then return; fi
  export LINKAGENT_LOCAL_STACK=1
  export LINKAGENT_PUBLIC_HOST=ide.localhost
  export FRPS_SERVER_ADDR="${FRPS_SERVER_ADDR:-127.0.0.1}"
}

start_node() {
  if [[ "$ENHANCE_DOCKER" == "1" ]]; then
    unset LINKAGENT_LOCAL_STACK_ENHANCE || true
    echo "→ Docker 模式：停止单机 PM node"
    pnpm --filter @linkagent/backend pm:stop node || true
    echo "→ Docker 模式：停止单机 code-server 容器"
    docker compose -f "$ROOT/.runtime-state/ide-proxy/compose.yml" down 2>/dev/null || true
    echo "→ Docker 模式：启动 linkagent-node"
    pnpm node:docker
    return
  fi
  if [[ "$ENHANCE" == "1" ]]; then
    export LINKAGENT_LOCAL_STACK_ENHANCE=1
    echo "→ 单机模式：PM node + code-server（8010）"
    pnpm image:code-server || true
    pnpm --filter @linkagent/backend pm:restart node
  else
    unset LINKAGENT_LOCAL_STACK_ENHANCE || true
    echo "→ node（原生 PM + 宿主机 frpc）"
    pnpm --filter @linkagent/backend pm:restart node
  fi
  if [[ "$ENHANCE" == "1" ]]; then
    echo "→ 单机模式：停止 Docker 模式节点（若存在）"
  else
    echo "→ 停止 Docker 模式节点（若存在）"
  fi
  pnpm node:docker:stop || true
}

case "$CMD" in
  start)
    if [[ "$ENHANCE_DOCKER" == "1" ]]; then
      export LINKAGENT_STACK_VERIFY_MODE=enhance-docker
      node "$DIR/dev-local-stack-edge-enhance.mjs"
    elif [[ "$ENHANCE" == "1" ]]; then
      export LINKAGENT_STACK_VERIFY_MODE=enhance
      node "$DIR/dev-local-stack-edge-enhance.mjs"
    else
      unset LINKAGENT_STACK_VERIFY_MODE || true
      node "$DIR/edge-server-ctl.mjs" start
      node "$DIR/dev-server-ctl.mjs" start
    fi
    pnpm --filter @linkagent/backend pm:restart channels || true
    local_stack_frp_env
    start_node
    ;;
  stop)
    unset LINKAGENT_LOCAL_STACK_ENHANCE || true
    pnpm node:docker:stop || true
    docker compose -f "$ROOT/.runtime-state/ide-proxy/compose.yml" down 2>/dev/null || true
    pnpm --filter @linkagent/backend pm:stop node || true
    pnpm --filter @linkagent/backend pm:stop channels || true
    node "$DIR/dev-server-ctl.mjs" stop
    node "$DIR/edge-server-ctl.mjs" stop
    ;;
  restart)
    bash "$0" stop
    if [[ "$ENHANCE_DOCKER" == "1" ]]; then bash "$0" start:enhance:docker
    elif [[ "$ENHANCE" == "1" ]]; then bash "$0" start:enhance
    else bash "$0" start; fi
    ;;
  status)
    echo "--- edge ---"
    node "$DIR/edge-server-ctl.mjs" status
    echo "--- gateway ---"
    node "$DIR/dev-server-ctl.mjs" status
    echo "--- pm ---"
    pnpm --filter @linkagent/backend pm:status
    echo "--- 单机 IDE / Docker 模式节点 ---"
    docker ps --filter name=linkagent-code-serve-web --filter name=linkagent-node --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true
    if [[ "$ENHANCE" == "1" || "${LINKAGENT_LOCAL_STACK_ENHANCE:-}" == "1" ]]; then
      export LINKAGENT_STACK_VERIFY_MODE=enhance
    fi
    node "$DIR/dev-verify-stack.mjs"
    ;;
  *) echo "用法: $0 {start|start:enhance|start:enhance:docker|stop|restart|status}"; exit 1 ;;
esac
