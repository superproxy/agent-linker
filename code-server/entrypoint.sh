#!/bin/sh
# 拉起 code-server，并一直保持工作区 dev server 与 VNC。dev / VNC 由 frpc 反向代理到 frps。
set -u

/usr/bin/entrypoint.sh "$@" &

dev_loop() {
  while true; do
    if [ -f /root/workspace/package.json ]; then
      cd /root/workspace || exit 0
      if [ ! -x node_modules/.bin/vite ]; then
        npm install || true
      fi
      npm run dev -- --host 0.0.0.0 --port 5173 --strictPort || true
    fi
    sleep 3
  done
}
dev_loop &

export DISPLAY=:1
Xvfb :1 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
sleep 1
openbox >/tmp/openbox.log 2>&1 &
x11vnc -display :1 -nopw -forever -shared -noxdamage -noshm -rfbport 5900 -localhost >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &

if [ -f /etc/linkagent/frpc.toml ]; then
  while true; do
    frpc -c /etc/linkagent/frpc.toml || true
    sleep 3
  done &
fi

(
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -sf -o /dev/null http://127.0.0.1:5173/; then
      chromium --no-sandbox --disable-dev-shm-usage --ozone-platform=x11 --disable-gpu --app=http://127.0.0.1:5173 --window-size=1280,800 --window-position=0,0 >/tmp/chromium.log 2>&1 || true
      break
    fi
    i=$((i + 1))
    sleep 2
  done
) &

wait
