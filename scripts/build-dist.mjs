#!/usr/bin/env node
/**
 * 独立部署包构建脚本
 *   pnpm build:dist   （或 node scripts/build-dist.mjs）
 *
 * 产出 dist/linkagent/ —— 自包含目录，整体拷贝到目标机器即可运行：
 *   server/index.mjs     网关 bundle（esbuild；npm 依赖 external，运行时从 node_modules 解析）
 *   server/config/       默认 gateway.yaml（可改）
 *   dev/                 内置聊天页/管理后台页（网关按相对路径 readFileSync）
 *   web/                 vite 构建的后台管理端（网关挂载到 /ui）
 *   vendor/openclaw/     openclaw plugin-sdk shim（产物 package.json 以 file: 依赖安装）
 *   node_modules/        运行时 npm 依赖（脚本内自动 npm install）
 *   .linkagent-root      部署根 marker（findInstallRoot 定位依据）
 *   start.sh / start.bat 启动脚本；README.md 使用说明
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

/**
 * 清理产物（保留 node_modules，由 npm install 增量同步依赖）：
 * 规避 IDE safe-delete 对单次大批量删除（>500 文件）的拦截。
 * 其余目录（server/web/dev/vendor 等）文件数远小于阈值，可整体删除。
 */
function cleanupDist(dist) {
  if (!existsSync(dist)) return;
  for (const entry of readdirSync(dist)) {
    if (entry === 'node_modules') continue;
    rmSync(join(dist, entry), { recursive: true, force: true });
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const DIST = join(REPO, 'dist', 'linkagent');

const BACKEND_PKG = JSON.parse(readFileSync(join(REPO, 'backend', 'package.json'), 'utf8'));
const SHARED_PKG = JSON.parse(readFileSync(join(REPO, 'shared', 'package.json'), 'utf8'));
const WEB_PKG = JSON.parse(readFileSync(join(REPO, 'web', 'package.json'), 'utf8'));

/** 需要 external（产物 node_modules 运行时解析）的 npm 包 */
const EXTERNAL_PACKAGES = [
  'fastify',
  '@fastify/cors',
  '@fastify/static',
  'yaml',
  'qrcode',
  'acpx',
  'zod',
  '@wecom/aibot-node-sdk',
  '@wecom/wecom-openclaw-plugin',
  '@tencent-weixin/openclaw-weixin',
];

/** 产物 package.json 的运行时依赖（npm 包 + openclaw shim 以 file: 引用） */
function runtimeDependencies() {
  const deps = { ...BACKEND_PKG.dependencies };
  // workspace 包：@linkagent/shared 被 bundle 进产物（无需安装）；openclaw shim 改为 file: 引用
  delete deps['@linkagent/shared'];
  deps['openclaw'] = 'file:./vendor/openclaw';
  // shared 的 zod 被 bundle 的 shared 源码引用，需随产物安装
  deps['zod'] ??= SHARED_PKG.dependencies.zod;
  return deps;
}

const step = (label, fn) => {
  console.log(`\n==> ${label}`);
  return fn();
};

step('1/6 清理旧产物（保留 node_modules 供 npm 增量）', () => {
  cleanupDist(DIST);
  mkdirSync(DIST, { recursive: true });
});

step('2/6 构建 web 管理端（vite）', () => {
  execFileSync('pnpm', ['--filter', '@linkagent/web', 'build'], { cwd: REPO, stdio: 'inherit' });
});

step('3/6 esbuild 打包网关', async () => {
  await esbuild({
    entryPoints: [join(REPO, 'backend', 'src', 'gateway', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL_PACKAGES,
    outfile: join(DIST, 'server', 'index.mjs'),
    sourcemap: true,
    logLevel: 'info',
  });
});

step('4/6 复制运行资源', () => {
  // 默认配置（server/config/gateway.yaml，产物布局路径）
  mkdirSync(join(DIST, 'server', 'config'), { recursive: true });
  cpSync(join(REPO, 'backend', 'config', 'gateway.yaml'), join(DIST, 'server', 'config', 'gateway.yaml'));

  // 内置页面（网关 new URL('../dev/*.html', import.meta.url) 相对 server/ 读取）
  cpSync(join(REPO, 'backend', 'src', 'dev', 'chat.html'), join(DIST, 'dev', 'chat.html'));
  cpSync(join(REPO, 'backend', 'src', 'dev', 'admin.html'), join(DIST, 'dev', 'admin.html'));

  // web 构建产物
  cpSync(join(REPO, 'web', 'dist'), join(DIST, 'web'), { recursive: true });

  // openclaw plugin-sdk shim（插件运行时 import 'openclaw/...' 从 node_modules 解析）
  cpSync(join(REPO, 'openclaw-shim', 'src'), join(DIST, 'vendor', 'openclaw', 'src'), { recursive: true });
  const shimPkg = JSON.parse(readFileSync(join(REPO, 'openclaw-shim', 'package.json'), 'utf8'));
  // npm 会静默跳过 private:true 的 file: 依赖 → 产物内 shim 包去掉 private（仅本地 file: 安装用）
  const shimOut = { ...shimPkg, private: false };
  writeFileSync(join(DIST, 'vendor', 'openclaw', 'package.json'), `${JSON.stringify(shimOut, null, 2)}\n`);

  // 部署根 marker
  writeFileSync(join(DIST, '.linkagent-root'), 'linkagent standalone deployment root\n');
});

step('5/6 生成 package.json / 启停脚本 / README', () => {
  const pkg = {
    name: 'linkagent',
    version: BACKEND_PKG.version,
    private: true,
    type: 'module',
    description: 'OpenAI 兼容网关独立部署包：Chatbox/Open WebUI → Gateway → ACP → agent',
    engines: { node: '>=22.13' },
    scripts: {
      start: 'node server/index.mjs',
      stop: 'node scripts/stop.mjs',
    },
    dependencies: runtimeDependencies(),
  };
  writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  writeFileSync(
    join(DIST, 'start.sh'),
    `#!/usr/bin/env bash
# linkagent 独立部署启停脚本
#   ./start.sh              启动（后台，等待健康检查）
#   ./start.sh stop         停止
#   ./start.sh restart      重启
#   ./start.sh status       查看状态
#   ./start.sh log          跟随日志
#   ./start.sh run          前台运行（Ctrl-C 停止）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
# 端口：LINKAGENT_PORT 优先，否则读 server/config/gateway.yaml 的 server.port，兜底 8787
PORT="\${LINKAGENT_PORT:-}"
if [ -z "$PORT" ]; then
  PORT="$(grep -E '^[[:space:]]+port:' "$DIR/server/config/gateway.yaml" 2>/dev/null | head -1 | grep -oE '[0-9]+')"
fi
PORT="\${PORT:-8787}"
PID_FILE="$DIR/.runtime-state/server.pid"
LOG_FILE="$DIR/.runtime-state/server.log"
BASE_URL="http://127.0.0.1:\${PORT}"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && return 0
  [ -n "$(lsof -ti:\${PORT} 2>/dev/null)" ] && return 0
  return 1
}

do_start() {
  if is_running; then
    echo "gateway 已在运行（pid $(cat "$PID_FILE" 2>/dev/null || echo "?")），url=\${BASE_URL}"
    return 0
  fi
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "→ 后台启动 gateway ..."
  cd "$DIR"
  nohup node server/index.mjs >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 20); do
    if curl -sS -m 2 "$BASE_URL/healthz" >/dev/null 2>&1; then
      echo "✅ gateway 已就绪：\${BASE_URL}（聊天页 / ，管理后台 /ui，OpenAI API /v1）"
      return 0
    fi
    sleep 1
  done
  echo "⚠️  启动超时，最近日志："
  tail -n 15 "$LOG_FILE"
  return 1
}

do_stop() {
  if ! is_running; then
    echo "gateway 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pids
  pids="$(lsof -ti:\${PORT} 2>/dev/null | tr '\\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in $(seq 1 15); do
    [ -z "$(lsof -ti:\${PORT} 2>/dev/null)" ] && break
    sleep 1
  done
  rm -f "$PID_FILE"
  echo "gateway 已停止"
}

case "\${1:-start}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop && do_start ;;
  status) if is_running; then echo "运行中 url=\${BASE_URL}"; else echo "未运行"; fi ;;
  log) tail -f "$LOG_FILE" ;;
  run) cd "$DIR" && exec node server/index.mjs ;;
  *) echo "用法: $0 {start|stop|restart|status|log|run}"; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(DIST, 'start.bat'),
    `@echo off
rem linkagent 独立部署启动脚本（Windows）
rem 用法: start.bat   启动（后台） / start.bat stop 停止
cd /d "%~dp0"
set "PORT=%LINKAGENT_PORT%"
if "%PORT%"=="" set "PORT=8787"
if "%1"=="stop" (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
  echo gateway 已停止
  exit /b 0
)
if not exist ".runtime-state" mkdir ".runtime-state"
start "linkagent-gateway" /min cmd /c "node server\\index.mjs > .runtime-state\\server.log 2>&1"
echo gateway 已启动（后台），健康检查 http://127.0.0.1:%PORT%/healthz
`,
  );

  writeFileSync(
    join(DIST, 'README.md'),
    `# linkagent 独立部署包

OpenAI 兼容网关：Chatbox / Open WebUI → \`/v1\` → ACP(acpx) → 本地 agent（opencode / pi / workbuddy / trace-cli ...）。

## 环境要求
- Node.js >= 22.13（含 npm）
- 目标机器已安装要使用的 agent CLI（如 \`opencode\`、\`pi\` 等）；未安装的 agent 启动时标记 unhealthy，调用会提示 \`ACP_BACKEND_UNAVAILABLE\`

## 目录结构
\`\`\`
linkagent/
├── server/
│   ├── index.mjs        网关（可直接 node server/index.mjs 前台运行）
│   └── config/gateway.yaml   网关配置（改完需重启）
├── dev/                 内置聊天页 / 管理页
├── web/                 后台管理端（挂载 /ui）
├── node_modules/        运行时依赖
└── .runtime-state/      运行态（首次启动自动创建：登录态、会话状态、日志、pid）
\`\`\`

## 启动
\`\`\`bash
./start.sh          # Linux/macOS：后台启动并等待健康检查
./start.sh stop     # 停止；./start.sh log 跟随日志；./start.sh run 前台运行
\`\`\`
\`\`\`bat
start.bat           # Windows：后台启动；start.bat stop 停止
\`\`\`

启动后：
- \`http://127.0.0.1:8787\` 内置聊天页
- \`http://127.0.0.1:8787/ui\` 后台管理端（agent 目录 / 模型 / 微信扫码登录）
- \`http://127.0.0.1:8787/v1\` OpenAI 兼容 API（Chatbox/Open WebUI 配置 base_url）
- \`http://127.0.0.1:8787/healthz\` 健康检查

端口可用环境变量 \`LINKAGENT_PORT\` 覆盖（默认 8787）；安装根可用 \`LINKAGENT_HOME\` 显式指定。

## 配置
编辑 \`server/config/gateway.yaml\`，修改后 \`./start.sh restart\`：
- \`server.host/port\`：监听地址
- \`auth\`：开启后所有 /v1 与后台 API 需 \`Authorization: Bearer <token>\`
- \`agents\`：覆盖内置默认 agent（id/type/displayName/description/cwd/command/model/...）
- \`tasks\`：任务路由默认 agent、任务工作空间目录
- \`plugins\` / \`channels\` / \`weixin\`：微信/企业微信渠道（默认 \`weixin.mode: weixin-bot\`，后台 /ui 扫码登录后自动收消息）

## 重新构建
在源码仓库执行 \`pnpm build:dist\`，产物在 \`dist/linkagent/\`。
`,
  );
});

step('6/6 安装产物运行时依赖', () => {
  const res = spawnSync(
    'npm',
    ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: DIST, stdio: 'inherit' },
  );
  if (res.status !== 0) {
    console.error('\n⚠️  npm install 失败。产物目录无法直接运行，请在 dist/linkagent 下手动执行：');
    console.error('   cd dist/linkagent && npm install --omit=dev --legacy-peer-deps');
    process.exit(res.status ?? 1);
  }
});

console.log(`\n✅ 独立部署包已生成：${DIST}`);
console.log('   启动：cd dist/linkagent && ./start.sh（Windows: start.bat）');
