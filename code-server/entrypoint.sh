#!/bin/sh
# 拉起 code-server，并一直保持工作区 dev server 与 VNC。dev / VNC 由 frpc 反向代理到 frps。
# 这三项的状态和输出写到 stdout，docker logs 能直接看到。
set -u

log() {
  printf '%s\n' "$1"
}

prefix() {
  tag=$1
  while IFS= read -r line; do
    printf '%s %s\n' "$tag" "$line"
  done
}

/usr/bin/entrypoint.sh "$@" &

log "[dev] 开启，工作区有 package.json 时监听 0.0.0.0:5173"
dev_loop() {
  while true; do
    if [ -f /root/workspace/package.json ]; then
      cd /root/workspace || exit 0
      if [ ! -x node_modules/.bin/vite ]; then
        log "[dev] npm install"
        npm install 2>&1 | prefix "[dev]" || true
      fi
      log "[dev] npm run dev --host 0.0.0.0 --port 5173"
      npm run dev -- --host 0.0.0.0 --port 5173 --strictPort 2>&1 | prefix "[dev]" || true
    fi
    sleep 3
  done
}
dev_loop &

log "[vnc] 开启，Xvfb :1，x11vnc 127.0.0.1:5900，noVNC 0.0.0.0:6080"
export DISPLAY=:1
Xvfb :1 -screen 0 1280x800x24 2>&1 | prefix "[vnc]" &
sleep 1
openbox 2>&1 | prefix "[vnc]" &
x11vnc -display :1 -nopw -forever -shared -noxdamage -noshm -rfbport 5900 -localhost 2>&1 | prefix "[vnc]" &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 2>&1 | prefix "[vnc]" &

if [ "${LINKAGENT_FRPC_BY_NODE:-}" = 1 ]; then
  log "[frpc] 等待 node 写入 /etc/linkagent/frpc.toml"
  i=0
  while [ ! -f /etc/linkagent/frpc.toml ] && [ "$i" -lt 20 ]; do
    i=$((i + 1))
    sleep 1
  done
fi
if [ -f /etc/linkagent/frpc.toml ]; then
  log "[frpc] 开启，配置 /etc/linkagent/frpc.toml"
  while true; do
    frpc -c /etc/linkagent/frpc.toml 2>&1 | prefix "[frpc]" || true
    log "[frpc] 退出，3 秒后重连"
    sleep 3
  done &
else
  log "[frpc] 未开启：没有 /etc/linkagent/frpc.toml"
fi

(
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -sf -o /dev/null http://127.0.0.1:5173/; then
      log "[vnc] 打开 Chromium http://127.0.0.1:5173"
      chromium --no-sandbox --disable-dev-shm-usage --ozone-platform=x11 --disable-gpu --app=http://127.0.0.1:5173 --window-size=1280,800 --window-position=0,0 2>&1 | prefix "[vnc]" || true
      break
    fi
    i=$((i + 1))
    sleep 2
  done
) &

wait
