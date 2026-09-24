/**
 * 安装布局（install layout）——形态判定与所有运行态路径的唯一真相源。
 *
 * 两种运行形态：
 *   - dev（仓库源码）：monorepo 根（含 pnpm-workspace.yaml），TS 源码 / backend/config / web/dist
 *   - dist（独立部署包）：含部署 marker `.linkagent-root` 的目录，server/*.mjs / server/config / web
 *
 * 历史上形态判定（existsSync('.linkagent-root')）、配置双候选、.runtime-state 子目录、
 * dev/dist 进程入口表、内置页面与 web 根的相对路径拼接散落在 gateway/config、gateway/index、
 * supervisor/manager、weixin-bot、weixin-login、node connector 等多处。本模块统一收敛，
 * 其余代码只描述「要什么」（state('nodes') / entry('gateway') / page('chat')），不关心形态。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_BASENAMES } from '@linkagent/shared';

export type InstallKind = 'dev' | 'dist';

/** 进程管理器托管的子进程标识（channels = channel-gateway 统一渠道进程） */
export type ProcessTargetId = 'gateway' | 'weixin' | 'channels' | 'node';

const DEPLOY_MARKER = '.linkagent-root';
const STATE_DIR = '.runtime-state';

/** 从任一子目录向上定位 monorepo 根（含 pnpm-workspace.yaml） */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * 定位「安装根」：独立部署产物（dist/linkagent）或仓库根（开发模式）。
 * 优先级：
 * 1. 环境变量 LINKAGENT_HOME（显式指定安装目录）
 * 2. 从本模块文件位置向上找部署 marker `.linkagent-root`
 * 3. 回退 monorepo 根（开发模式，含 pnpm-workspace.yaml）
 *
 * 产物内所有运行态目录都相对此根解析，因此 dist 目录可整体拷贝到任意机器运行。
 */
export function findInstallRoot(): string {
  const env = process.env.LINKAGENT_HOME;
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, DEPLOY_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return findRepoRoot();
}

/** dev 形态下 tsx 的 ESM loader 入口（相对给定安装根） */
function tsxLoaderFor(root: string): string {
  // 用 `node --import <tsx>` 直跑 TS 入口（而非 .bin/tsx 启动脚本）：
  // .bin/tsx 是会再 spawn 一个 node 子进程的 shell/cmd 包装，记到的是短命 launcher，
  // 无法可靠停止真实服务；node --import 直跑 spawn 出的就是服务进程本身。
  return join(root, 'backend', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
}

/** 三个托管进程的 dev/dist 入口（相对安装根） */
const PROCESS_ENTRIES: Record<ProcessTargetId, { dev: string; dist: string }> = {
  gateway: { dev: join('backend', 'src', 'gateway', 'index.ts'), dist: join('server', 'gateway.mjs') },
  weixin: { dev: join('backend', 'src', 'channels', 'weixin-bot.ts'), dist: join('server', 'weixin.mjs') },
  node: { dev: join('backend', 'src', 'node', 'connector.ts'), dist: join('server', 'node.mjs') },
  channels: { dev: join('backend', 'src', 'channels', 'channel-gateway.ts'), dist: join('server', 'channels.mjs') },
};

export interface InstallLayout {
  /** 运行形态：dist 独立部署包 / dev 仓库源码 */
  readonly kind: InstallKind;
  /** 安装根（dist）或 monorepo 根（dev），绝对路径 */
  readonly root: string;
  /** config.yaml 的有序候选路径（形态优先，均不存在时取首个作为报告路径） */
  readonly configCandidates: string[];
  /** 配置目录（gateway.yaml / weixin.yaml / node.yaml 与 config.yaml 同目录） */
  readonly configDir: string;
  /** split：gateway.yaml 存在；none：无启动前 yaml（用内置默认 + 运行时 overlay） */
  readonly configMode: 'split' | 'none';
  /** 主配置路径：split 时为 gateway.yaml，否则为形态默认 gateway.yaml 路径（可能尚未创建） */
  readonly configFile: string;
  /** 自动生成的永久 gateway token 落盘路径 <root>/.runtime-state/gateway-token（三进程共享，0600） */
  readonly gatewayTokenFile: string;
  /** 运行态根目录 <root>/.runtime-state */
  readonly stateRoot: string;
  /** 拼接 <root>/.runtime-state/<...segments> */
  state(...segments: string[]): string;
  readonly pluginsState: string;
  readonly acpxState: string;
  readonly nodesState: string;
  readonly usersState: string;
  readonly tasksState: string;
  readonly tasksWorkspace: string;
  readonly prefsState: string;
  readonly nodeState: string;
  readonly pmState: string;
  readonly pmLogs: string;
  /** web 管理端静态根（探测到 index.html + assets 才返回，否则 undefined） */
  readonly webRoot: string | undefined;
  /**
   * 内置 HTML 页面绝对路径（仅 chat 聊天页）。
   * 页面是随代码走的资源：基于本模块自身位置解析（dev→src/dev，dist bundle→dist/dev），
   * 不随 LINKAGENT_HOME 变化（与状态根/配置根解耦）。
   * 管理后台已迁移到 TS/React 构建产物（webRoot，挂在 /），不再有内置 admin.html。
   */
  page(name: 'chat'): string;
  /** dev 形态 tsx ESM loader 绝对路径（dist 形态不用） */
  readonly tsxLoader: string;
  /** 某托管进程在当前形态下的入口绝对路径 */
  entry(id: ProcessTargetId): string;
  /** 微信扫码登录引导（形态感知：dist 无 pnpm，只引导后台 /） */
  readonly loginHint: string;
  /** external 模式下重启微信进程的命令提示（形态感知） */
  readonly restartWeixinHint: string;
  /** channel-gateway 模式下重启渠道进程 */
  readonly restartChannelsHint: string;
}

/** 依据安装根构造布局（可传任意 root，便于单测） */
export function createInstallLayout(root: string = findInstallRoot()): InstallLayout {
  const kind: InstallKind = existsSync(join(root, DEPLOY_MARKER)) ? 'dist' : 'dev';
  const state = (...segments: string[]) => join(root, STATE_DIR, ...segments);

  // 配置候选：形态优先，另一形态作为兜底（两形态目录互不存在，结果与历史双候选一致）
  const configCandidates =
    kind === 'dist'
      ? [join(root, 'server', 'config', CONFIG_BASENAMES.gateway), join(root, 'backend', 'config', CONFIG_BASENAMES.gateway)]
      : [join(root, 'backend', 'config', CONFIG_BASENAMES.gateway), join(root, 'server', 'config', CONFIG_BASENAMES.gateway)];

  const configDir = dirname(configCandidates[0]!);
  const splitGateway = join(configDir, CONFIG_BASENAMES.gateway);
  let configMode: InstallLayout['configMode'] = 'none';
  let configFile = configCandidates[0]!;
  if (existsSync(splitGateway)) {
    configMode = 'split';
    configFile = splitGateway;
  }

  // web 管理端：dist 为 <root>/web；dev 为 vite 产物 <root>/web/dist（兜底 <root>/web）
  const webCandidates = kind === 'dist' ? [join(root, 'web')] : [join(root, 'web', 'dist'), join(root, 'web')];
  const webRoot = webCandidates.find((p) => existsSync(join(p, 'index.html')) && existsSync(join(p, 'assets')));

  // 内置页面随代码走：本模块 dev 在 src/install/、dist bundle 在 server/，两者的 ../dev 即页面目录。
  // 基于模块自身位置（而非安装根/LINKAGENT_HOME）解析，测试把 LINKAGENT_HOME 指到临时目录时仍能找到页面。
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const pageDir = join(moduleDir, '..', 'dev');
  const pageFile = (name: 'chat') => join(pageDir, `${name}.html`);

  const loginHint =
    kind === 'dist'
      ? '请打开后台管理端 / 扫码登录'
      : '请先扫码登录：pnpm --filter @linkagent/backend weixin-login（或打开后台 / 扫码）';
  const restartWeixinHint =
    kind === 'dist'
      ? './start.sh restart weixin（Windows：start.bat restart weixin）'
      : 'pnpm pm restart weixin';
  const restartChannelsHint =
    kind === 'dist'
      ? './start.sh restart channels（Windows：start.bat restart channels）'
      : 'pnpm pm restart channels';

  return {
    kind,
    root,
    configCandidates,
    configDir,
    configMode,
    configFile,
    gatewayTokenFile: state('gateway-token'),
    stateRoot: state(),
    state,
    pluginsState: state('plugins'),
    acpxState: state('acpx'),
    nodesState: state('nodes'),
    usersState: state('users'),
    tasksState: state('tasks'),
    tasksWorkspace: state('tasks-workspace'),
    prefsState: state('prefs'),
    nodeState: state('node'),
    pmState: state('pm'),
    pmLogs: state('pm', 'logs'),
    webRoot,
    page: pageFile,
    tsxLoader: tsxLoaderFor(root),
    entry: (id) => join(root, PROCESS_ENTRIES[id][kind]),
    loginHint,
    restartWeixinHint,
    restartChannelsHint,
  };
}

let cached: { envHome: string | undefined; layout: InstallLayout } | undefined;
/**
 * 进程内单例（形态/根只探测一次）；测试可传 root 用 {@link createInstallLayout}。
 * 以 LINKAGENT_HOME 为缓存键：该 env 显式改变安装根时（测试隔离运行态目录）随之重建。
 */
export function getLayout(): InstallLayout {
  const envHome = process.env.LINKAGENT_HOME;
  if (!cached || cached.envHome !== envHome) {
    cached = { envHome, layout: createInstallLayout() };
  }
  return cached.layout;
}
