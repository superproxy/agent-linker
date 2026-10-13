#!/usr/bin/env bash
# gateway / channels / node 进程编排（安装根目录执行，内部 node bin/pm.mjs）
#   ./server-ctl.sh start|stop|restart [all|gateway|weixin|node]
#   ./server-ctl.sh status | logs | foreground
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
CMD="${1:-start}"
TARGET="${2:-all}"
case "$CMD" in
  start|stop|restart) exec node bin/pm.mjs "$CMD" "$TARGET" ;;
  status) exec node bin/pm.mjs status ;;
  logs|log) exec node bin/pm.mjs logs "$TARGET" ;;
  foreground|fg|run) exec node bin/pm.mjs foreground "$TARGET" ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|foreground} [all|gateway|weixin|node]"
    exit 1
    ;;
esac
