#!/usr/bin/env node
/**
 * 独立部署包构建脚本
 *   pnpm build:dist                         整包 dist/linkagent（网关 + 微信 + 节点 + 后台）
 *   pnpm build:dist:node                    执行机包 dist/linkagent-node（仅节点连接器）
 *   node scripts/build-dist.mjs --target=node --skip-install --out=<dir>
 *
 * 整包：
 *   server/gateway.mjs / weixin.mjs / node.mjs / pm.mjs
 *   web/ 后台、dev/ 聊天页、vendor/openclaw
 * 节点包：
 *   server/node.mjs + server/ctl.mjs（启停）+ 精简运行时依赖（acpx / ws）
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

function parseArgs(argv) {
  let target = 'full';
  let skipInstall = false;
  let out;
  for (const a of argv) {
    if (a === '--target=node' || a === '--node') target = 'node';
    else if (a === '--target=full' || a === '--full') target = 'full';
    else if (a === '--skip-install') skipInstall = true;
    else if (a.startsWith('--out=')) out = a.slice('--out='.length);
  }
  return { target, skipInstall, out };
}

function cleanupDist(dist) {
  if (!existsSync(dist)) return;
  for (const entry of readdirSync(dist)) {
    if (entry === 'node_modules') continue;
    rmSync(join(dist, entry), { recursive: true, force: true });
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const BACKEND_PKG = JSON.parse(readFileSync(join(REPO, 'backend', 'package.json'), 'utf8'));
const SHARED_PKG = JSON.parse(readFileSync(join(REPO, 'shared', 'package.json'), 'utf8'));

const FULL_EXTERNAL = [
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
  '@openclaw/feishu',
  '@tencent-weixin/openclaw-weixin',
];

/** 节点包：acpx / ws 运行时解析；yaml / zod 打进 bundle，执行机少装依赖 */
const NODE_EXTERNAL = ['acpx', 'ws'];

/**
 * ESM 产物没有 CJS require。yaml 等被 bundle 的 CJS 会 `require('node:process')`，
 * 若不注入 createRequire，启动会报 Dynamic require of "node:process" is not supported。
 */
const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __linkagentCreateRequire } from 'node:module';\nconst require = __linkagentCreateRequire(import.meta.url);\n",
};

function esbuildServerBundle(entryPoints, outdir, external) {
  return esbuild({
    entryPoints,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    outdir,
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
    sourcemap: true,
    logLevel: 'info',
    banner: ESM_REQUIRE_BANNER,
  });
}

function runtimeDependenciesFull() {
  const deps = { ...BACKEND_PKG.dependencies };
  delete deps['@linkagent/shared'];
  deps['openclaw'] = 'file:./vendor/openclaw';
  deps['zod'] ??= SHARED_PKG.dependencies.zod;
  return deps;
}

function runtimeDependenciesNode() {
  const deps = {};
  for (const name of NODE_EXTERNAL) {
    const ver = BACKEND_PKG.dependencies[name];
    if (!ver) throw new Error(`backend/package.json 缺少运行时依赖 ${name}`);
    deps[name] = ver;
  }
  return deps;
}

/** 复制 split 启动配置（gateway / weixin / node 三文件） */
function copySplitConfig(destDir, profile) {
  mkdirSync(destDir, { recursive: true });
  if (profile === 'node') {
    writeFileSync(join(destDir, 'gateway.yaml'), NODE_GATEWAY_YAML);
    writeFileSync(join(destDir, 'node.yaml'), NODE_YAML);
    return;
  }
  for (const name of ['gateway.yaml', 'weixin.yaml', 'channels.yaml', 'node.yaml']) {
    const live = join(REPO, 'backend', 'config', name);
    const template = join(REPO, 'backend', 'config', `${name}.template`);
    const src = existsSync(live) ? live : template;
    if (!existsSync(src)) throw new Error(`缺少 backend/config/${name} 或 ${name}.template`);
    cpSync(src, join(destDir, name));
  }
}

/** destRoot = 独立包根（含 server/config、scripts） */
function copyPiSetup(destRoot) {
  const piAgentSrc = join(REPO, 'backend', 'config', 'pi-agent');
  if (existsSync(piAgentSrc)) {
    cpSync(piAgentSrc, join(destRoot, 'server', 'config', 'pi-agent'), { recursive: true });
  }
  mkdirSync(join(destRoot, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'setup-pi.mjs'), join(destRoot, 'scripts', 'setup-pi.mjs'));
  cpSync(join(REPO, 'scripts', 'setup-channels.mjs'), join(destRoot, 'scripts', 'setup-channels.mjs'));
}

/** Node 22 起直接 spawn *.cmd 会 EINVAL，Windows 必须走 shell。 */
function runBin(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
}

function npmInstall(dist) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(
    npm,
    ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dist, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (res.status !== 0) {
    console.error(`\n⚠️  npm install 失败。请在 ${dist} 下手动执行：`);
    console.error('   npm install --omit=dev --legacy-peer-deps');
    process.exit(res.status ?? 1);
  }
}

const NODE_CTL_SOURCE = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(root, '.runtime-state');
const pidFile = join(stateDir, 'node.pid');
const logFile = join(stateDir, 'node.log');
const envFile = join(stateDir, 'node.env');
const entry = join(root, 'server', 'node.mjs');
const cmd = (process.argv[2] ?? 'start').toLowerCase();

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\\r?\\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[line.slice(0, eq).trim()] = val;
  }
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const text = readFileSync(pidFile, 'utf8').trim();
  if (!/^\\d+$/.test(text)) return null;
  return Number(text);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function running() {
  const pid = readPid();
  return pid !== null && alive(pid);
}

function stopTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

loadEnvFile(envFile);
process.env.LINKAGENT_HOME = process.env.LINKAGENT_HOME || root;

if (cmd === 'status') {
  if (running()) console.log(\`节点运行中 pid=\${readPid()}  日志 \${logFile}\`);
  else console.log('节点未运行');
  process.exit(0);
}

if (cmd === 'stop') {
  const pid = readPid();
  if (pid && alive(pid)) stopTree(pid);
  if (existsSync(pidFile)) unlinkSync(pidFile);
  console.log('节点已停止');
  process.exit(0);
}

if (cmd === 'log' || cmd === 'logs') {
  if (!existsSync(logFile)) {
    console.log('暂无日志（节点尚未启动过）');
    process.exit(0);
  }
  process.stdout.write(readFileSync(logFile));
  process.exit(0);
}

if (cmd === 'foreground' || cmd === 'fg' || cmd === 'run') {
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 1));
} else if (cmd === 'start' || cmd === 'restart') {
  if (cmd === 'restart') {
    const pid = readPid();
    if (pid && alive(pid)) stopTree(pid);
    if (existsSync(pidFile)) unlinkSync(pidFile);
  }
  if (running()) {
    console.log(\`节点已在运行 (pid \${readPid()})\`);
    process.exit(0);
  }
  mkdirSync(stateDir, { recursive: true });
  const logFd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  writeFileSync(pidFile, \`\${child.pid}\\n\`);
  child.unref();
  console.log(\`✅ 节点已启动 (pid \${child.pid}，日志 \${logFile})\`);
} else {
  console.error('用法: node server/ctl.mjs {start|stop|restart|status|log|foreground}');
  process.exit(1);
}
`;

const NODE_README = `# linkagent-node 执行节点独立包

在执行机上运行节点连接器：出站 WebSocket 连入网关，本机拉起 ACP agent（opencode / pi / …）。

## 环境要求
- Node.js >= 22.13（含 npm）
- 本机已安装要上报的 agent CLI（pi 可用 \`npm run setup:pi\` 安装并生成 ~/.pi/agent 配置）

## 目录
\`\`\`
linkagent-node/
├── server/node.mjs          节点连接器
├── server/ctl.mjs           启停
├── server/config/gateway.yaml   # 仅推导缺省回连地址
├── server/config/node.yaml      # 自报 agent、pi 权限与 setup:pi 说明
├── server/config/pi-agent/      # npm run setup:pi 模板
├── start.sh / start.bat
├── node.env.example
└── node_modules/
\`\`\`

## 配置
优先环境变量（或复制 \`node.env.example\` 为 \`.runtime-state/node.env\`）：

\`\`\`
LINKAGENT_GATEWAY_URL=wss://gw.example.com
LINKAGENT_GATEWAY_TOKEN=网关静态 token 或 nt_ 机器 token
LINKAGENT_NODE_NAME=builder-01
LINKAGENT_NODE_AGENTS=opencode,pi
\`\`\`

编辑 \`server/config/node.yaml\`（\`agents\`、\`gatewayUrl\` / \`gatewayToken\`）。pi 模型清单不在 yaml：在本机执行 \`npm run setup:pi\`（模板在 \`server/config/pi-agent/\`）。

## 启动
\`\`\`bash
./start.sh                 # 后台启动
./start.sh status
./start.sh log
./start.sh stop
./start.sh foreground      # 前台
\`\`\`
\`\`\`bat
start.bat
start.bat status
start.bat stop
start.bat foreground
\`\`\`

首次匿名接入时，到网关后台「节点」审批；之后会把 secret 落到 \`.runtime-state/node/\`。
`;

const NODE_ENV_EXAMPLE = `# 复制为 .runtime-state/node.env 后启动（不要把令牌写进命令行历史）
LINKAGENT_GATEWAY_URL=wss://gw.example.com
LINKAGENT_GATEWAY_TOKEN=
LINKAGENT_NODE_NAME=
# LINKAGENT_NODE_AGENTS=opencode,pi
`;

const NODE_GATEWAY_YAML = `# linkagent-node：仅用于缺省回连地址与鉴权模式推导（agent 清单见 node.yaml）
server:
  host: 127.0.0.1
  port: 8787
auth:
  mode: local
  token: ""
`;

const NODE_YAML = `# linkagent-node 执行机：节点自报 agent 与 ACP 权限
# 回连优先：LINKAGENT_GATEWAY_URL / LINKAGENT_GATEWAY_TOKEN 或 .runtime-state/node.env
enabled: true
# name: builder-01
agents:
  - opencode
  - id: pi
    permissionMode: approve-all
    # pi 会话 model 不写 yaml；本机执行 npm run setup:pi（server/config/pi-agent 模板 → ~/.pi/agent）
  - workbuddy
  - trace-cli
  - id: cursor
    permissionMode: approve-all
# gatewayUrl: wss://gw.example.com
# gatewayToken: ""
`;

const step = (label, fn) => {
  console.log(`\n==> ${label}`);
  return fn();
};

async function buildFull(dist, skipInstall) {
  step('1/6 清理旧产物（保留 node_modules 供 npm 增量）', () => {
    cleanupDist(dist);
    mkdirSync(dist, { recursive: true });
  });

  step('2/6 构建 web 管理端（vite）', () => {
    runBin(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@linkagent/web', 'build'], REPO);
  });

  step('3/6 esbuild 打包（gateway / channels / weixin / node / pm 五入口）', async () => {
    const src = join(REPO, 'backend', 'src');
    await esbuildServerBundle(
      {
        gateway: join(src, 'gateway', 'index.ts'),
        channels: join(src, 'channels', 'channel-gateway.ts'),
        weixin: join(src, 'channels', 'weixin-bot.ts'),
        node: join(src, 'node', 'connector.ts'),
        pm: join(src, 'supervisor', 'cli.ts'),
      },
      join(dist, 'server'),
      FULL_EXTERNAL,
    );
  });

  step('4/6 复制运行资源', () => {
    copySplitConfig(join(dist, 'server', 'config'), 'full');
    copyPiSetup(dist);
    cpSync(join(REPO, 'skills'), join(dist, 'skills'), { recursive: true });
    mkdirSync(join(dist, 'dev'), { recursive: true });
    cpSync(join(REPO, 'backend', 'src', 'dev', 'chat.html'), join(dist, 'dev', 'chat.html'));
    cpSync(join(REPO, 'web', 'dist'), join(dist, 'web'), { recursive: true });
    cpSync(join(REPO, 'openclaw-shim', 'src'), join(dist, 'vendor', 'openclaw', 'src'), { recursive: true });
    const shimPkg = JSON.parse(readFileSync(join(REPO, 'openclaw-shim', 'package.json'), 'utf8'));
    writeFileSync(join(dist, 'vendor', 'openclaw', 'package.json'), `${JSON.stringify({ ...shimPkg, private: false }, null, 2)}\n`);
    writeFileSync(join(dist, '.linkagent-root'), 'linkagent standalone deployment root\n');
  });

  step('5/6 生成 package.json / 启停脚本 / README', () => {
    writeFileSync(
      join(dist, 'package.json'),
      `${JSON.stringify(
        {
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
            'setup:pi': 'node scripts/setup-pi.mjs',
            'setup:channels': 'node scripts/setup-channels.mjs',
          },
          dependencies: runtimeDependenciesFull(),
        },
        null,
        2,
      )}\n`,
    );

    writeFileSync(
      join(dist, 'start.sh'),
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
      join(dist, 'start.bat'),
      `@echo off
rem linkagent 单机进程管理器（gateway + 微信 + node 三进程）
cd /d "%~dp0"
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
set "TARGET=%~2"
if "%TARGET%"=="" set "TARGET=all"
node server\\pm.mjs %CMD% %TARGET%
`,
    );

    writeFileSync(join(dist, 'README.md'), FULL_README);
  });

  if (!skipInstall) {
    step('6/6 安装产物运行时依赖', () => npmInstall(dist));
  } else {
    console.log('\n==> 6/6 跳过 npm install（--skip-install）');
  }

  console.log(`\n✅ 独立部署包已生成：${dist}`);
  console.log('   启动三进程：cd 该目录 && ./start.sh（Windows: start.bat）');
}

const FULL_README = `# linkagent 独立部署包

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
│   └── config/               gateway.yaml / weixin.yaml / node.yaml（改完需 restart）
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
网关开启 \`auth\` 时，微信/node 进程自动读取 \`server/config/gateway.yaml\` 的静态 token 回连，无需单独配置。
微信首次使用需先在后台 \`/admin\` 扫码登录。

启动后：
- \`http://127.0.0.1:8787\` 内置聊天页
- \`http://127.0.0.1:8787/admin\` 后台管理端（agent / 任务 / Key / 节点 / 微信扫码 / 进程管理）
- \`http://127.0.0.1:8787/v1\` OpenAI 兼容 API（Chatbox/Open WebUI 配置 base_url）
- \`http://127.0.0.1:8787/healthz\` 健康检查

安装根可用 \`LINKAGENT_HOME\` 显式指定。

## 配置
编辑 \`server/config/\` 下三文件（修改后 \`./start.sh restart\`）：
- \`gateway.yaml\`：\`server.host/port\`、\`auth\`、网关侧 \`agents\` / \`tasks\` / \`plugins\` / \`channels\`
- \`weixin.yaml\`：个人微信渠道；单机包 \`mode: external\`，后台 /admin 扫码
- \`node.yaml\`：本机节点连接器、\`node.agents\`（含 pi 等 ACP 权限）
运行时变更（agent 启停、微信账号列表、子进程回连地址等）写入 \`.runtime-state/gateway/overlay.json\`，不改上述 yaml。

## 重新构建
在源码仓库执行 \`pnpm build:dist\`，产物在 \`dist/linkagent/\`。
执行机只需节点连接器时，用 \`pnpm build:dist:node\`，产物在 \`dist/linkagent-node/\`。
`;

async function buildNode(dist, skipInstall) {
  step('1/4 清理旧产物（保留 node_modules 供 npm 增量）', () => {
    cleanupDist(dist);
    mkdirSync(dist, { recursive: true });
  });

  step('2/4 esbuild 打包节点连接器', async () => {
    const src = join(REPO, 'backend', 'src');
    await esbuildServerBundle({ node: join(src, 'node', 'connector.ts') }, join(dist, 'server'), NODE_EXTERNAL);
  });

  step('3/4 生成配置 / 启停 / README', () => {
    mkdirSync(join(dist, 'server', 'config'), { recursive: true });
    copySplitConfig(join(dist, 'server', 'config'), 'node');
    writeFileSync(join(dist, 'server', 'ctl.mjs'), NODE_CTL_SOURCE);
    writeFileSync(join(dist, '.linkagent-root'), 'linkagent-node standalone deployment root\n');
    writeFileSync(join(dist, 'node.env.example'), NODE_ENV_EXAMPLE);
    writeFileSync(join(dist, 'README.md'), NODE_README);
    copyPiSetup(dist);
    writeFileSync(
      join(dist, 'package.json'),
      `${JSON.stringify(
        {
          name: 'linkagent-node',
          version: BACKEND_PKG.version,
          private: true,
          type: 'module',
          description: 'LinkAgent 执行节点独立包：出站 WS 连入网关，本机跑 ACP agent',
          engines: { node: '>=22.13' },
          scripts: {
            start: 'node server/ctl.mjs start',
            stop: 'node server/ctl.mjs stop',
            restart: 'node server/ctl.mjs restart',
            status: 'node server/ctl.mjs status',
            logs: 'node server/ctl.mjs log',
            foreground: 'node server/ctl.mjs foreground',
            'setup:pi': 'node scripts/setup-pi.mjs',
          },
          dependencies: runtimeDependenciesNode(),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dist, 'start.sh'),
      `#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
CMD="\${1:-start}"
exec node server/ctl.mjs "$CMD"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dist, 'start.bat'),
      `@echo off
cd /d "%~dp0"
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
node server\\ctl.mjs %CMD%
`,
    );
  });

  if (!skipInstall) {
    step('4/4 安装产物运行时依赖', () => npmInstall(dist));
  } else {
    console.log('\n==> 4/4 跳过 npm install（--skip-install）');
  }

  console.log(`\n✅ 节点独立包已生成：${dist}`);
  console.log('   启动：cd 该目录 && ./start.sh（Windows: start.bat）');
}

async function main() {
  const { target, skipInstall, out } = parseArgs(process.argv.slice(2));
  if (target === 'node') {
    const dist = resolve(out || join(REPO, 'dist', 'linkagent-node'));
    await buildNode(dist, skipInstall);
    return;
  }
  const dist = resolve(out || join(REPO, 'dist', 'linkagent'));
  await buildFull(dist, skipInstall);
}

await main();
