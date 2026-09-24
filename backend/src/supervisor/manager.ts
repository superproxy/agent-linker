/**
 * 单机三进程编排（仅拉起 / 停止，不常驻守护）：
 *   gateway  —— 网关（OpenAI 兼容 API + 后台 + 节点 WS 接入）
 *   weixin   —— 个人微信 bot 独立进程（external 模式，gateway 不再内嵌）
 *   node     —— 本机 node 节点连接器（反向 WS 连入本机 gateway）
 *
 * 两种运行形态：
 *   - dev（仓库源码）：用 backend/node_modules/.bin/tsx 直接跑 TS 入口
 *   - dist（独立部署包）：node 跑 server/{gateway,weixin,node}.mjs
 * 通过安装根是否存在 .linkagent-root marker 判定。
 *
 * 运行态统一落 <installRoot>/.runtime-state/pm/：
 *   <id>.pid  后台进程 pid；logs/<id>.log  各自日志
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createInstallLayout,
  type InstallLayout,
  type ProcessTargetId,
} from '../install/layout.js';
import { loadSharedConfig, resolveChildRuntime, loopbackHost } from '../gateway/config.js';
import type { SharedConfig } from '@linkagent/shared';
import {
  IS_WINDOWS,
  killTree,
  readPid,
  removePid,
  sleep,
  spawnAttached,
  spawnDetached,
  waitDead,
  writePid,
} from './proc.js';

export type TargetId = ProcessTargetId;

/**
 * 进程实例 id：基目标 gateway | channels | node | weixin，
 * 以及兼容别名 `weixin:<accountId>`（expand → `channels`，不再起独立 OS 进程）。
 */
export type ProcessInstanceId = TargetId | `weixin:${string}`;

export const ALL_TARGETS: TargetId[] = ['gateway', 'weixin', 'channels', 'node'];

/** 启动顺序：gateway 先就绪，再起渠道与节点（二者依赖网关） */
const START_ORDER: TargetId[] = ['gateway', 'weixin', 'channels', 'node'];
/** 停止顺序：反序，先停依赖方 */
const STOP_ORDER: TargetId[] = ['node', 'weixin', 'channels', 'gateway'];

/** 是否合法进程目标 id（含 weixin:<accountId> 兼容别名） */
export function isKnownTargetId(id: string): id is ProcessInstanceId {
  return (ALL_TARGETS as string[]).includes(id) || /^weixin:[A-Za-z0-9._-]+$/.test(id);
}

/** pid/log 文件名安全化（账号 id 中非文件名友好字符替换为 _） */
export function safeAccountKey(accountId: string): string {
  return accountId.replace(/[^A-Za-z0-9._-]/g, '_');
}

export interface InstanceSpec {
  base: TargetId;
  label: string;
  /** pid/log 文件名的键（如 weixin / weixin-acc1） */
  pidKey: string;
  /** 账号实例的账号 id（仅 weixin:<id> 有） */
  accountId?: string;
}

/** 实例归一化：基目标 + 展示名 + pid 键 + 可选账号 id */
export function instOf(id: ProcessInstanceId): InstanceSpec {
  if (id === 'gateway' || id === 'weixin' || id === 'channels' || id === 'node') {
    return { base: id, label: TARGETS[id].label, pidKey: id };
  }
  const accountId = id.slice('weixin:'.length);
  return {
    base: 'weixin',
    label: `微信 bot · ${accountId}`,
    pidKey: `weixin-${safeAccountKey(accountId)}`,
    accountId,
  };
}

export interface TargetSpec {
  id: TargetId;
  label: string;
  /** 健康检查 URL（可选）：启动后轮询该地址 */
  healthUrl?: (base: string) => string;
}

/** 进程展示名（dev/dist 入口统一由 install/layout 提供） */
export const TARGETS: Record<TargetId, TargetSpec> = {
  gateway: { id: 'gateway', label: 'gateway 网关', healthUrl: (base) => `${base}/healthz` },
  weixin: { id: 'weixin', label: '微信 bot' },
  channels: { id: 'channels', label: 'channel-gateway 渠道' },
  node: { id: 'node', label: 'node 节点' },
};

export interface TargetStatus {
  id: ProcessInstanceId;
  label: string;
  running: boolean;
  pid: number | null;
  logFile: string;
}

export interface ManagerPaths {
  root: string;
  stateDir: string;
  logDir: string;
}

/** 从有效启动配置（split 三文件或 config.yaml）解析网关地址 / 鉴权 / token，供子进程回连 */
export interface GatewayRuntimeConfig {
  port: number;
  host: string;
  authEnabled: boolean;
  token: string;
  /** 三进程共享配置（含 weixin/node 段 enabled 开关） */
  shared: SharedConfig;
}

export function loadGatewayRuntimeConfig(layout: InstallLayout): GatewayRuntimeConfig {
  // 子进程自行读同一配置文件推导回连参数；supervisor 仅需端口做健康检查、enabled 决定是否拉起。
  // token 文件由 gateway 进程首启时生成；supervisor 这里只读（resolveChildRuntime 内部只读不创建）。
  // 与 gateway 一致：split 时用 layout.configFile（gateway.yaml）触发三文件合并，避免误读 stub config.yaml。
  const configPath = layout.configMode === 'none' ? undefined : layout.configFile;
  const { config } = loadSharedConfig(configPath, layout.state('gateway'));
  const { host: rawHost, port } = config.gateway.server;
  const mode = config.gateway.auth.mode;
  // 透传 layout 的 token 文件路径，确保测试/多实例隔离（不回退读全局安装布局的 token）
  const runtime = resolveChildRuntime(config, {}, {}, layout.gatewayTokenFile);
  return {
    port,
    host: loopbackHost(rawHost),
    authEnabled: mode !== 'open',
    token: runtime.gatewayToken,
    shared: config,
  };
}

export class ProcessManager {
  readonly paths: ManagerPaths;
  private readonly layout: InstallLayout;
  private readonly gw: GatewayRuntimeConfig;
  private readonly extraWeixinAccounts?: () => string[];

  constructor(root?: string, opts: { extraWeixinAccounts?: () => string[] } = {}) {
    this.layout = createInstallLayout(root);
    this.paths = {
      root: this.layout.root,
      stateDir: this.layout.pmState,
      logDir: this.layout.pmLogs,
    };
    this.gw = loadGatewayRuntimeConfig(this.layout);
    this.extraWeixinAccounts = opts.extraWeixinAccounts;
  }

  get baseUrl(): string {
    return `http://${this.gw.host}:${this.gw.port}`;
  }

  pidFile(id: ProcessInstanceId): string {
    return join(this.paths.stateDir, `${instOf(id).pidKey}.pid`);
  }

  logFile(id: ProcessInstanceId): string {
    return join(this.paths.logDir, `${instOf(id).pidKey}.log`);
  }

  /** 组装某目标的启动命令与环境变量（入口由布局层按形态给出：dist→server/*.mjs，dev→tsx 直跑 TS） */
  private resolve(id: ProcessInstanceId): { command: string; args: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {};
    const entry = this.layout.entry(instOf(id).base);
    const args =
      this.layout.kind === 'dist'
        ? [entry]
        : ['--import', pathToFileURL(this.layout.tsxLoader).href, entry];
    return { command: process.execPath, args, env };
  }

  /** 个人微信是否由 channels 进程托管（不再起 weixin:<账号> 独立进程） */
  private weixinUsesChannels(): boolean {
    const shared = this.gw.shared;
    if (shared.channelGateway?.enabled === true) return true;
    const accounts = this.weixinAccountList();
    return shared.weixin.enabled !== false && accounts.length > 0;
  }

  /** 某进程在共享配置段里是否启用（pm start all 时 enabled:false 跳过；显式单起不拦截） */
  isEnabled(id: ProcessInstanceId): boolean {
    const base = instOf(id).base;
    if (base === 'channels') {
      if (this.gw.shared.channelGateway?.enabled === true) return true;
      return this.weixinUsesChannels();
    }
    if (base === 'weixin') return false;
    if (base === 'node') return this.gw.shared.node.enabled;
    return true;
  }

  /** 已绑定的微信账号 id（yaml ∪ 运行时）；未绑定则不维护进程 */
  weixinAccountList(): string[] {
    const yaml = this.gw.shared.weixin.accounts ?? [];
    const extra = this.extraWeixinAccounts?.() ?? [];
    const accounts: string[] = [];
    for (const a of [...yaml, ...extra]) {
      if (a && !accounts.includes(a)) accounts.push(a);
    }
    return accounts;
  }

  /** @deprecated 个人微信已合并进 channels；保留空列表兼容旧调用 */
  weixinInstanceIds(): ProcessInstanceId[] {
    return [];
  }

  /** 全量实例：gateway → channels（企微/微信/飞书）→ node */
  allInstanceIds(): ProcessInstanceId[] {
    const ids: ProcessInstanceId[] = ['gateway'];
    if (this.gw.shared.channelGateway?.enabled === true || this.weixinUsesChannels()) {
      ids.push('channels');
    }
    ids.push('node');
    return ids;
  }

  /** 展开：weixin → 账号实例列表（或默认单实例），其余原样；去重保序 */
  expand(ids: ProcessInstanceId[]): ProcessInstanceId[] {
    const out: ProcessInstanceId[] = [];
    for (const id of ids) {
      let expanded: ProcessInstanceId[];
      if (id === 'weixin') {
        expanded = this.weixinUsesChannels() ? ['channels'] : [];
      } else if (/^weixin:/.test(id)) {
        expanded = this.weixinUsesChannels() ? ['channels'] : [];
      } else {
        expanded = [id];
      }
      for (const x of expanded) {
        if (!out.includes(x)) out.push(x);
      }
    }
    return out;
  }

  /** 按基目标在 order 中的次序排列实例（用于 start/stop/restart 的顺序控制） */
  private orderByBase(ids: ProcessInstanceId[], order: TargetId[]): ProcessInstanceId[] {
    const instances = this.expand(ids);
    return order.flatMap((base) => instances.filter((id) => instOf(id).base === base));
  }

  private envFor(id: ProcessInstanceId): Record<string, string> {
    const spec = instOf(id);
    switch (spec.base) {
      case 'gateway': {
        const env: Record<string, string> = { LINKAGENT_WEIXIN_MODE: 'raw' };
        if (this.gw.shared.channelGateway?.enabled) env.LINKAGENT_CHANNEL_GATEWAY = '1';
        return env;
      }
      case 'channels':
        return {
          LINKAGENT_GATEWAY_URL: '',
          LINKAGENT_GATEWAY_TOKEN: '',
        };
      case 'weixin':
        // 回连 URL/token 由 weixin 进程自行读共享配置推导，supervisor 不再当二传手；
        // 同时显式把 LINKAGENT_GATEWAY_URL/TOKEN 置空，覆盖父进程（shell/systemd/docker）
        // 继承值，避免本机 bot 被残留环境变量带到远程网关（独立 weixin 进程仍可用环境变量）。
        // 账号实例注入账号 id，weixin-bot 入口据此加载指定登录态（缺省取 accounts/ 下第一个）
        return {
          ...(spec.accountId ? { LINKAGENT_ACCOUNT_ID: spec.accountId } : {}),
          LINKAGENT_GATEWAY_URL: '',
          LINKAGENT_GATEWAY_TOKEN: '',
        };
      case 'node':
        // 回连地址、token、展示名、agent 清单由 node 进程读 node.yaml，不再注入环境变量。
        return {};
    }
  }

  isRunning(id: ProcessInstanceId): boolean {
    return readPid(this.pidFile(id)) !== null;
  }

  /**
   * 历史默认 `weixin` 单进程遗留的 weixin.pid / weixin.log。
   * 现已合并进 channels；操作 weixin/channels 时顺带收割孤儿 weixin 进程。
   */
  private async reapOrphanDefaultWeixin(ids: ProcessInstanceId[]): Promise<void> {
    const expanded = this.expand(ids);
    const mentionsWeixinOrChannels =
      ids.some((id) => instOf(id).base === 'weixin' || id === 'channels') ||
      expanded.some((id) => id === 'channels' || instOf(id).base === 'weixin');
    if (!mentionsWeixinOrChannels) return;
    if (!readPid(this.pidFile('weixin'))) return;
    console.log('→ 停止遗留的默认微信进程 weixin（已合并进 channels）');
    await this.stopOne('weixin');
  }

  async start(ids: ProcessInstanceId[] = this.allInstanceIds()): Promise<void> {
    const requestedWeixin = ids.some((id) => instOf(id).base === 'weixin');
    await this.reapOrphanDefaultWeixin(ids);
    const expanded = this.expand(ids);
    if (
      requestedWeixin &&
      !expanded.some((id) => id === 'channels' || instOf(id).base === 'weixin')
    ) {
      console.log(
        'ℹ️  尚未绑定微信账号且未启用 channel-gateway，跳过渠道进程。请在「微信登录」扫码绑定或启用 channels.yaml 后再重启。',
      );
    }
    for (const id of expanded) {
      await this.startOne(id);
    }
  }

  private async startOne(id: ProcessInstanceId): Promise<void> {
    const spec = instOf(id);
    if (!this.isEnabled(id)) {
      console.log(`⏭️  ${spec.label} 在配置中已禁用（weixin.enabled=false / node.enabled=false），跳过`);
      return;
    }
    const existing = readPid(this.pidFile(id));
    if (existing) {
      console.log(`ℹ️  ${spec.label} 已在运行 (pid ${existing})，跳过`);
      return;
    }
    const { command, args, env } = this.resolve(id);
    const logFile = this.logFile(id);
    console.log(`→ 后台启动 ${spec.label} ...`);
    const child = spawnDetached({ command, args, cwd: this.paths.root, env: this.envFor(id), logFile });
    if (!child.pid) {
      console.error(`❌ ${spec.label} 启动失败，请查看日志：${logFile}`);
      return;
    }
    writePid(this.pidFile(id), child.pid);

    if (spec.base === 'gateway') {
      const ready = await this.waitHealthy(20_000);
      if (ready) {
        console.log(`✅ ${spec.label} 已就绪：${this.baseUrl}/v1（日志 ${logFile}）`);
      } else {
        console.warn(`⚠️  ${spec.label} 健康检查超时（可能仍在启动），最近日志：`);
        this.tailLog(id, 15);
      }
    } else {
      // 给子进程一点启动时间，确认没有立即退出（如微信未扫码登录会 exit 1）
      await sleep(1200);
      const pid = readPid(this.pidFile(id));
      if (pid) {
        console.log(`✅ ${spec.label} 已启动 (pid ${pid}，日志 ${logFile})`);
      } else {
        console.warn(`⚠️  ${spec.label} 启动后退出（可能尚未登录/配置缺失），最近日志：`);
        this.tailLog(id, 15);
      }
    }
  }

  async stop(ids: ProcessInstanceId[] = this.orderByBase(this.allInstanceIds(), STOP_ORDER)): Promise<void> {
    await this.reapOrphanDefaultWeixin(ids);
    for (const id of this.expand(ids)) {
      await this.stopOne(id);
    }
  }

  private async stopOne(id: ProcessInstanceId): Promise<void> {
    const spec = instOf(id);
    const pid = readPid(this.pidFile(id));
    if (!pid) {
      console.log(`ℹ️  ${spec.label} 未在运行`);
      removePid(this.pidFile(id));
      return;
    }
    console.log(`→ 停止 ${spec.label} (pid ${pid}) ...`);
    await killTree(pid, 'SIGTERM');
    await waitDead(pid, 10_000);
    removePid(this.pidFile(id));
    console.log(`✅ ${spec.label} 已停止`);
  }

  async restart(ids: ProcessInstanceId[] = this.allInstanceIds()): Promise<void> {
    // 重启：先按反序停掉指定目标，再按启动顺序拉起
    const stopIds = this.orderByBase(ids, STOP_ORDER);
    const startIds = this.orderByBase(ids, START_ORDER);
    await this.reapOrphanDefaultWeixin(ids);
    await this.stop(stopIds);
    await this.start(startIds);
  }

  status(): TargetStatus[] {
    return this.allInstanceIds().map((id) => {
      const pid = readPid(this.pidFile(id));
      const spec = instOf(id);
      return {
        id,
        label: spec.label,
        running: pid !== null,
        pid,
        logFile: this.logFile(id),
      };
    });
  }

  printStatus(): void {
    for (const s of this.status()) {
      console.log(
        s.running ? `运行中  ${s.id.padEnd(8)} pid=${s.pid}` : `已停止  ${s.id.padEnd(8)}`,
      );
    }
  }

  async waitHealthy(timeoutMs: number): Promise<boolean> {
    const url = TARGETS.gateway.healthUrl!(this.baseUrl);
    const stepMs = 500;
    for (let waited = 0; waited < timeoutMs; waited += stepMs) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return true;
      } catch {
        /* 未就绪，继续等 */
      }
      await sleep(stepMs);
    }
    return false;
  }

  private tailLog(id: ProcessInstanceId, lines: number): void {
    const tail = this.readTailLog(id, lines);
    if (tail) console.log(tail);
  }

  /** 读取某目标日志文件的尾部 N 行（供 web 进程管理展示；无日志返回空串） */
  readTailLog(id: ProcessInstanceId, lines = 200): string {
    try {
      const text = readFileSync(this.logFile(id), 'utf8');
      return text.trimEnd().split('\n').slice(-Math.max(1, lines)).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * 网关自重启（web 触发）：spawn 一个零依赖的 detached 接力 node 进程后返回。
   * 接力进程等待当前网关（oldPid）退出、端口释放，再按当前形态（dev tsx / dist mjs）
   * 重新 detached 拉起网关并接管 pid 文件；调用方应在响应发出后自行 SIGTERM 退出。
   */
  relaunchGateway(oldPid: number = process.pid): void {
    const { command, args } = this.resolve('gateway');
    const relayEnv: Record<string, string> = {
      LA_OLD_PID: String(oldPid),
      LA_HEALTH_URL: TARGETS.gateway.healthUrl!(this.baseUrl),
      LA_GW_CMD: command,
      LA_GW_ARGS: JSON.stringify(args),
      LA_GW_CWD: this.paths.root,
      LA_GW_PIDFILE: this.pidFile('gateway'),
      LA_GW_LOGFILE: this.logFile('gateway'),
      LA_GW_ENV: JSON.stringify(this.envFor('gateway')),
      LA_IS_WINDOWS: IS_WINDOWS ? '1' : '',
    };
    // 接力脚本仅用 node 内置模块（net/child_process/fs），CommonJS 写法以 --input-type=commonjs 强制解析
    const script = `
const net=require('net'),cp=require('child_process'),fs=require('fs');
const oldPid=+process.env.LA_OLD_PID;
const healthUrl=process.env.LA_HEALTH_URL;
const isWin=process.env.LA_IS_WINDOWS==='1';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const alive=(pid)=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const u=new URL(healthUrl);
const portFree=()=>new Promise((resolve)=>{
  const s=net.connect(Number(u.port),u.hostname);
  s.once('connect',()=>{s.destroy();resolve(false);});
  s.once('error',()=>resolve(true));
});
(async()=>{
  // 1) 等旧进程退出（最多 15s）
  for(let i=0;i<150 && alive(oldPid);i++) await sleep(100);
  // 2) 等监听端口释放
  for(let i=0;i<100;i++){ if(await portFree()) break; await sleep(100); }
  await sleep(300);
  // 3) 重新拉起网关
  const cmd=process.env.LA_GW_CMD;
  const args=JSON.parse(process.env.LA_GW_ARGS||'[]');
  const extra=JSON.parse(process.env.LA_GW_ENV||'{}');
  const env={...process.env,...extra};
  for(const k of Object.keys(process.env)) if(k.startsWith('LA_')) delete env[k];
  const logFile=process.env.LA_GW_LOGFILE;
  let out='ignore',err='ignore';
  if(logFile){fs.mkdirSync(require('path').dirname(logFile),{recursive:true});const fd=fs.openSync(logFile,'a');out=fd;err=fd;}
  const child=cp.spawn(cmd,args,{cwd:process.env.LA_GW_CWD,env,detached:true,windowsHide:isWin,stdio:['ignore',out,err]});
  child.unref();
  if(child.pid) fs.writeFileSync(process.env.LA_GW_PIDFILE,String(child.pid));
  process.exit(0);
})().catch(()=>process.exit(1));
`;
    const relay = spawn(process.execPath, ['--input-type=commonjs', '-e', script], {
      detached: true,
      windowsHide: IS_WINDOWS,
      stdio: 'ignore',
      env: { ...process.env, ...relayEnv },
    });
    relay.unref();
  }

  /**
   * 前台联调：gateway 直接继承终端；weixin/node 用 attached 子进程（带前缀输出）。
   * Ctrl-C 时一并退出。不写 pid 文件（与后台模式互不干扰，但若端口占用 gateway 会报错）。
   */
  async foreground(ids: ProcessInstanceId[] = this.allInstanceIds()): Promise<void> {
    const children: ReturnType<typeof spawnAttached>[] = [];
    let stopping = false;

    const cleanup = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\n→ 停止全部进程 ...');
      for (const c of children) {
        if (c.pid) await killTree(c.pid, 'SIGTERM').catch(() => {});
      }
      process.exit(0);
    };
    process.on('SIGINT', () => void cleanup());
    process.on('SIGTERM', () => void cleanup());

    for (const id of this.expand(ids)) {
      const spec = instOf(id);
      const { command, args, env } = this.resolve(id);
      console.log(`→ 前台启动 ${spec.label} ...`);
      const child = spawnAttached({ command, args, cwd: this.paths.root, env: this.envFor(id), logFile: null });
      children.push(child);
      child.on('exit', (code) => {
        if (!stopping) console.log(`[${id}] 退出 code=${code}`);
      });
      if (spec.base === 'gateway') {
        const ready = await this.waitHealthy(20_000);
        if (!ready) console.warn('⚠️  gateway 健康检查超时，继续启动其余进程');
      } else {
        await sleep(1000);
      }
    }
    // 常驻，直到收到信号
    await new Promise<void>(() => {});
  }
}

/** 解析目标参数：all/缺省 → 全部基目标；单个目标 → 仅该目标（weixin / weixin:<id> 为兼容别名） */
export function parseTargets(input?: string): ProcessInstanceId[] {
  if (!input || input === 'all') return [...ALL_TARGETS];
  if (isKnownTargetId(input)) return [input];
  throw new Error(`未知进程 "${input}"，可选：${['all', ...ALL_TARGETS, 'weixin:<accountId>'].join(' | ')}`);
}
