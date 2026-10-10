#!/usr/bin/env bash
# 构建本地聚合镜像 linkagent-node:local。
# 不经过 scripts/image-node.mjs。先打包 dist/linkagent-node，再打两层镜像。
#   scripts/build-node.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v pnpm.cmd >/dev/null 2>&1; then
  PNPM=(pnpm.cmd)
else
  echo "未找到 pnpm" >&2
  exit 1
fi

echo "→ 打包 dist/linkagent-node"
"${PNPM[@]}" build:dist:node

echo "→ 构建 linkagent-code-server:local"
docker build -t linkagent-code-server:local -f "$ROOT/code-server/Dockerfile" "$ROOT/code-server"

CTX="$(mktemp -d "${TMPDIR:-/tmp}/linkagent-node-image.XXXXXX")"
cleanup() { rm -rf "$CTX"; }
trap cleanup EXIT

cp -a "$ROOT/dist/linkagent-node" "$CTX/linkagent-node"
mkdir -p "$CTX/code-server"
cp "$ROOT/code-server/render-frpc.mjs" "$CTX/code-server/render-frpc.mjs"
cp "$ROOT/code-server/entrypoint-bundle.sh" "$CTX/code-server/entrypoint-bundle.sh"

echo "→ 构建 linkagent-node:local"
docker build -f "$ROOT/code-server/Dockerfile.bundle" -t linkagent-node:local "$CTX"
echo "镜像 linkagent-node:local 已构建"
