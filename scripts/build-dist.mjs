#!/usr/bin/env node
/**
 * 独立部署包构建脚本
 *   pnpm build:dist   （或 node scripts/build-dist.mjs）
 *
 * 产出 dist/linkagent/ —— 自包含目录，整体拷贝到目标机器即可运行：
 *   server/gateway.mjs   网关 bundle（esbuild；npm 依赖 external，运行时从 node_modules 解析）
 *   server/weixin.mjs    个人微信 bot 独立进程（external 模式）
 *   server/node.mjs      本机 node 节点连接器
 *   server/pm.mjs        单机进程管理器（编排三进程）
 *   server/config/       默认 config.yaml（可改）
 *   dev/                 内置聊天页（网关按相对路径 readFileSync）
 *   web/                 vite 构建的后台管理端（TS/React，网关挂载到 /admin）
 *   vendor/openclaw/     openclaw plugin-sdk shim（产物 package.json 以 file: 依赖安装）
 *   node_modules/        运行时 npm 依赖（脚本内自动 npm install）
 *   .linkagent-root      部署根 marker（findInstallRoot 定位依据）
 *   start.sh / start.bat 启动脚本（调 pm.mjs）；README.md 使用说明
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
  'ws',
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

step('3/6 esbuild 打包（gateway / weixin / node / pm 四入口）', async () => {
  const src = join(REPO, 'backend', 'src');
  await esbuild({
    entryPoints: {
      gateway: join(src, 'gateway', 'index.ts'),
      weixin: join(src, 'channels', 'weixin-bot.ts'),
      node: join(src, 'node', 'connector.ts'),
      pm: join(src, 'supervisor', 'cli.ts'),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL_PACKAGES,
    outdir: join(DIST, 'server'),
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
    sourcemap: true,
    logLevel: 'info',
  });
});

step('4/6 复制运行资源', () => {
  // 默认配置（server/config/config.yaml，产物布局路径）
  mkdirSync(join(DIST, 'server', 'config'), { recursive: true });
  cpSync(join(REPO, 'backend', 'config', 'config.yaml'), join(DIST, 'server', 'config', 'config.yaml'));

  // 内置页面（网关 new URL('../dev/*.html', import.meta.url) 相对 server/ 读取）
  // 仅聊天页；管理后台为 web/ 下的 TS/React 构建产物（挂 /admin），不再内置 admin.html。
  cpSync(join(REPO, 'backend', 'src', 'dev', 'chat.html'), join(DIST, 'dev', 'chat.html'));

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
      start: 'node server/pm.mjs start',
      stop: 'node server/pm.mjs stop',
      restart: 'node server/pm.mjs restart',
      status: 'node server/pm.mjs status',
      logs: 'node server/pm.mjs logs',
      gateway: 'node server/gateway.mjs',
    },
    dependencies: runtimeDependencies(),
  };
  writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  writeFileSync(
    join(DIST, 'start.sh'),
    `#!/usr/bin/env bash
# linkagent 单机进程管理器（gateway + 微信 + node 三进程，仅编排拉起不守护）
#   ./start.sh              后台启动全部三进程（gateway 就绪后再起微信/node）
#   ./start.sh stop         停止全部
#   ./start.sh restart      重启全部
#   ./start.sh status       查看三进程状态
#   ./start.sh logs         跟随全部日志
#   ./start.sh foreground   前台联调（Ctrl-C 一起退出）
#   ./start.sh start gateway|weixin|node   仅操作单个进程
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
CMD="\${1:-start}"
TARGET="\${2:-all}"
case "$CMD" in
  start|stop|restart) exec node server/pm.mjs "$CMD" "$TARGET" ;;
  status) exec node server/pm.mjs status ;;
  logs) exec node server/pm.mjs logs "$TARGET" ;;
  foreground|fg|run) exec node server/pm.mjs foreground "$TARGET" ;;
  *) echo "用法: $0 {start|stop|restart|status|logs|foreground} [all|gateway|weixin|node]"; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(DIST, 'start.bat'),
    `@echo off
rem linkagent 单机进程管理器（gateway + 微信 + node 三进程）
rem   start.bat            后台启动全部
rem   start.bat stop       停止全部
rem   start.bat restart    重启全部
rem   start.bat status     查看状态
rem   start.bat logs       跟随日志
rem   start.bat foreground 前台联调（Ctrl-C 退出）
cd /d "%~dp0"
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
set "TARGET=%~2"
if "%TARGET%"=="" set "TARGET=all"
node server\\pm.mjs %CMD% %TARGET%
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
│   ├── gateway.mjs       网关（OpenAI 兼容 API + 后台 + 节点接入）
│   ├── weixin.mjs        个人微信 bot（独立进程，external 模式）
│   ├── node.mjs          本机 node 节点连接器（反向 WS 连入网关）
│   ├── pm.mjs            单机进程管理器（编排上面三进程）
│   └── config/config.yaml    网关配置（改完需重启）
├── dev/                  内置聊天页
├── web/                  后台管理端（TS/React，挂载 /admin）
├── node_modules/         运行时依赖
└── .runtime-state/       运行态（登录态、会话、pm 日志/pid）
\`\`\`

## 启动（单机三进程：gateway + 微信 + node）
\`\`\`bash
./start.sh              # 后台启动全部（gateway 就绪后再起微信/node）
./start.sh status       # 查看三进程状态
./start.sh logs         # 跟随全部日志（Ctrl-C 只退出查看，不停进程）
./start.sh stop         # 停止全部；restart 重启；foreground 前台联调
./start.sh start weixin # 仅操作单个进程：gateway|weixin|node
\`\`\`
\`\`\`bat
start.bat               # Windows：后台启动全部；start.bat stop/status/logs
\`\`\`

进程管理器只负责拉起/停止（不常驻、崩溃不自动重启）；进程崩溃后重新执行 \`./start.sh start\` 即可。
网关开启 \`auth\` 时，微信/node 进程自动读取同一 \`config.yaml\` 的静态 token 回连，无需单独配置。
微信首次使用需先在后台 \`/admin\` 扫码登录。

启动后：
- \`http://127.0.0.1:8787\` 内置聊天页
- \`http://127.0.0.1:8787/admin\` 后台管理端（agent / 任务 / Key / 节点 / 微信扫码 / 进程管理）
- \`http://127.0.0.1:8787/v1\` OpenAI 兼容 API（Chatbox/Open WebUI 配置 base_url）
- \`http://127.0.0.1:8787/healthz\` 健康检查

安装根可用 \`LINKAGENT_HOME\` 显式指定。

## 配置
编辑 \`server/config/config.yaml\`（gateway / weixin / node 三进程共享同一文件），修改后 \`./start.sh restart\`：
- \`gateway.server.host/port\`：监听地址
- \`gateway.auth.mode\`：\`local\`（默认，本机浏览器免登录，他机/API 需永久 gateway token）/ \`token\`（强制令牌）/ \`open\`（不鉴权）
- \`gateway.auth.token\`：留空则首启自动生成并落盘 \`.runtime-state/gateway-token\`（三进程共享）
- \`gateway.agents\`：覆盖内置默认 agent（id/type/displayName/description/cwd/command/model/...）
- \`gateway.tasks\`：任务路由默认 agent、任务工作空间目录
- \`gateway.plugins\` / \`gateway.channels\` 与 \`weixin\`：微信/企业微信渠道。单机包由进程管理器托管，网关以 \`weixin.mode: external\` 运行（微信在独立进程，后台 /admin 扫码登录后自动收消息）
- \`weixin.enabled\` / \`node.enabled\`：\`pm start all\` 时是否拉起对应进程

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
console.log('   启动三进程：cd dist/linkagent && ./start.sh（Windows: start.bat）');
