import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, isAcpRuntimeError, type AcpxRuntime } from 'acpx/runtime';
import type { AgentDefinition, AgentDescriptor, PermissionPolicySpec } from '@linkagent/shared';
import { ACP_AGENT_KINDS } from '@linkagent/shared';
import { lastUserText } from '@linkagent/shared/opencode';
import { collectModelCandidates } from '../modelcandidates.js';

export type AcpAgentKind = (typeof ACP_AGENT_KINDS)[number];

/**
 * 展开路径中的用户主目录：Node 的 path.resolve 不会展开 `~`，
 * 用户在任务 cwd 里填 `~/test` 会被当成相对路径拼成 `<网关cwd>/~/test`（不存在）→ spawn ENOENT。
 * 支持 `~` 与 `~/xxx`（不展开 `~user` 其他用户形式）。
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** 解析工作目录：先展开 ~，再转绝对路径 */
export function resolveCwd(p: string): string {
  return resolve(expandHome(p.trim()));
}

/** 各 ACP agent 的默认启动命令（definition.command / options.command 可覆盖） */
export const DEFAULT_COMMANDS: Record<AcpAgentKind, string[]> = {
  // --port 0：opencode acp 会读 opencode.json 的 server.port 并尝试绑定固定端口，
  // 多实例并发时后到者 ServeError 崩溃（实测根因）。--port 0 跳过固定端口绑定。
  opencode: ['opencode', 'acp', '--port', '0'],
  // pi 本身没有 ACP server：经官方收录的 pi-acp 桥接（内部 spawn `pi --mode rpc`）
  pi: ['npx', '-y', 'pi-acp'],
  // workbuddy = CodeBuddy Code CLI：官方文档 `codebuddy --acp` 启动 ACP server
  workbuddy: ['codebuddy', '--acp'],
  // trace-cli = TraeCode CLI 2.0：官方文档 `traecli acp serve`（或 `traecli --acp`）
  'trace-cli': ['traecli', 'acp', 'serve'],
  // ── acpx@0.15.1 内置 registry 其余类型（对应 CLI 本机安装后才可用）──
  codex: ['npx', '-y', '@agentclientprotocol/codex-acp'],
  claude: ['npx', '-y', '@agentclientprotocol/claude-agent-acp'],
  gemini: ['gemini', '--acp'],
  // cursor = Cursor CLI：当前安装入口是 `agent acp`（`cursor-agent acp` 在仅有 dist-package 的安装上会找不到版本目录）
  cursor: ['agent', 'acp'],
  copilot: ['copilot', '--acp', '--stdio'],
  droid: ['droid', 'exec', '--output-format', 'acp'],
  'fast-agent': ['uvx', 'fast-agent-mcp', 'acp'],
  'grok-build': ['grok', 'agent', 'stdio'],
  // hermes = Nous Hermes Agent：官方 `hermes acp` / `hermes-acp` stdio ACP server（需 pip/uv 安装 .[acp]）
  hermes: ['hermes', 'acp'],
  iflow: ['iflow', '--experimental-acp'],
  kilocode: ['npx', '-y', '@kilocode/cli', 'acp'],
  kimi: ['kimi', 'acp'],
  kiro: ['kiro-cli-chat', 'acp'],
  mcode: ['mcode', 'acp'],
  mux: ['npx', '-y', 'mux', 'acp'],
  openclaw: ['openclaw', 'acp'],
  pool: ['pool', 'acp'],
  qoder: ['qodercli', '--acp'],
  qwen: ['qwen', '--acp'],
  zeroclaw: ['zeroclaw', 'acp'],
  // zcode 不在 acpx 内置 registry：经 registry override 注册到全局安装的 zcode-acp-server
  // （npm i -g zcode-acp-server；bin 无参即 stdio ACP server，内部派生 `zcode app-server --stdio`）。
  // 注意：不要用 `zcode-acp` 无参（那是交互式 TUI，不是 ACP server）。
  zcode: ['zcode-acp-server'],
};

/** 各 ACP agent 的缺省展示信息（definition.displayName/description 可覆盖） */
export const DEFAULT_LABELS: Record<AcpAgentKind, { displayName: string; description: string }> = {
  opencode: { displayName: 'OpenCode', description: '本地 opencode（ACP/acpx），默认只读问答' },
  pi: { displayName: 'Pi', description: '本地 pi（pi-coding-agent，经 pi-acp 桥接），默认只读问答' },
  workbuddy: { displayName: 'WorkBuddy', description: 'CodeBuddy Code CLI（codebuddy --acp），默认只读问答' },
  'trace-cli': { displayName: 'TraeCode CLI', description: 'TraeCode CLI（traecli acp serve），默认只读问答' },
  codex: { displayName: 'Codex', description: 'OpenAI Codex CLI（经 ACP 适配器），默认只读问答' },
  claude: { displayName: 'Claude', description: 'Claude Code（经 ACP 适配器），默认只读问答' },
  gemini: { displayName: 'Gemini', description: 'Gemini CLI（gemini --acp），默认只读问答' },
  cursor: { displayName: 'Cursor', description: 'Cursor CLI（agent acp），默认只读问答' },
  copilot: { displayName: 'Copilot', description: 'GitHub Copilot CLI（copilot --acp --stdio），默认只读问答' },
  droid: { displayName: 'Droid', description: 'Factory Droid（droid exec --output-format acp），默认只读问答' },
  'fast-agent': { displayName: 'Fast Agent', description: 'Fast Agent（uvx fast-agent-mcp acp），默认只读问答' },
  'grok-build': { displayName: 'Grok Build', description: 'Grok Build（grok agent stdio），默认只读问答' },
  hermes: { displayName: 'Hermes', description: 'Hermes Agent（hermes acp），默认只读问答' },
  iflow: { displayName: 'iFlow', description: 'iFlow CLI（iflow --experimental-acp），默认只读问答' },
  kilocode: { displayName: 'Kilocode', description: 'Kilocode CLI（npx @kilocode/cli acp），默认只读问答' },
  kimi: { displayName: 'Kimi', description: 'Kimi CLI（kimi acp），默认只读问答' },
  kiro: { displayName: 'Kiro', description: 'Kiro CLI（kiro-cli-chat acp），默认只读问答' },
  mcode: { displayName: 'MCode', description: 'MiniMax MCode（mcode acp），默认只读问答' },
  mux: { displayName: 'Mux', description: 'Mux / Coder（经 ACP 适配器），默认只读问答' },
  openclaw: { displayName: 'OpenClaw', description: 'OpenClaw（openclaw acp），默认只读问答' },
  pool: { displayName: 'Poolside', description: 'Poolside（pool acp），默认只读问答' },
  qoder: { displayName: 'Qoder', description: 'Qoder CLI（qodercli --acp），默认只读问答' },
  qwen: { displayName: 'Qwen Code', description: 'Qwen Code（qwen --acp），默认只读问答' },
  zeroclaw: { displayName: 'ZeroClaw', description: 'ZeroClaw（zeroclaw acp），默认只读问答' },
  zcode: { displayName: 'ZCode', description: 'ZCode（zcode-acp-server，需 npm i -g zcode-acp-server），默认只读问答' },
};

/** 本机安装指引：命令框展示用；argv 存在才允许网关代执行（固定白名单，不跑用户改写的文本） */
export interface AgentInstallGuide {
  command: string;
  hint?: string;
  argv?: string[];
}

function npmGlobal(pkg: string, hint?: string): AgentInstallGuide {
  const argv = process.platform === 'win32' ? ['npm.cmd', 'i', '-g', pkg] : ['npm', 'i', '-g', pkg];
  return { command: `npm i -g ${pkg}`, argv, hint };
}

/**
 * 按类型给出本机安装命令。npx -y 的类型默认落到 `npm i -g <包>`，可一键执行；
 * 含管道 / 需交互登录的安装只展示命令，由用户在终端自行执行。
 */
export function installGuideFor(kind: AcpAgentKind, platform = process.platform): AgentInstallGuide {
  switch (kind) {
    case 'opencode':
      return npmGlobal('opencode-ai', '安装后启动命令：opencode acp --port 0');
    case 'pi':
      return npmGlobal(
        'pi-acp',
        '只装 ACP 桥接。完整安装（pi CLI + 生成 ~/.pi/agent 模型配置）请在仓库根执行 pnpm setup:pi。启动命令：npx -y pi-acp',
      );
    case 'workbuddy':
      return {
        command: 'codebuddy --version',
        hint: '请按 CodeBuddy Code CLI 文档安装 codebuddy，并确认已在 PATH 中。',
      };
    case 'trace-cli':
      return {
        command: 'traecli --version',
        hint: '请按 TraeCode CLI 文档安装 traecli（https://docs.trae.cn/cli），安装后可执行 traecli doctor。',
      };
    case 'hermes':
      return {
        command: 'hermes acp --check',
        hint: '请先安装 Hermes Agent 并启用 ACP（如 uv pip install -e \'.[acp]\'）。启动命令：hermes acp 或 hermes-acp；健康检查：hermes acp --check',
      };
    case 'cursor':
      return platform === 'win32'
        ? {
            command: 'irm https://cursor.com/install?win=1 | iex',
            hint: '在 PowerShell 中执行；也可从 Cursor 应用安装 CLI。安装后确认 agent 在 PATH 中。',
          }
        : {
            command: 'curl https://cursor.com/install -fsS | bash',
            hint: '安装后确认 agent 在 PATH 中，启动命令：agent acp',
          };
    case 'gemini':
      return npmGlobal('@google/gemini-cli', '安装后启动命令：gemini --acp');
    case 'copilot':
      return npmGlobal('@github/copilot', '安装后启动命令：copilot --acp --stdio');
    case 'qwen':
      return npmGlobal('@qwen-code/qwen-code', '安装后启动命令：qwen --acp');
    case 'zcode':
      return npmGlobal('zcode-acp-server', '安装后启动命令：zcode-acp-server');
    case 'fast-agent':
      return {
        command: 'uvx fast-agent-mcp acp',
        hint: '需已安装 uv；uvx 会按需拉取包，一般无需再全局安装。',
      };
    default: {
      const cmd = DEFAULT_COMMANDS[kind];
      const pkg = cmd[0] === 'npx' && cmd[1] === '-y' ? cmd[2] : undefined;
      if (pkg) return npmGlobal(pkg, `安装后仍可用：${cmd.join(' ')}`);
      return {
        command: cmd.join(' '),
        hint: '请先安装对应 CLI，并确保启动命令在 PATH 中可用。',
      };
    }
  }
}

/** 管理后台目录条目（不含配置状态；configured/enabled 由 AgentManager 组装） */
export interface AgentCatalogEntry {
  kind: AcpAgentKind;
  displayName: string;
  description: string;
  command: string[];
  installCommand: string;
  installRunnable: boolean;
  installHint?: string;
}

function catalogEntry(kind: AcpAgentKind): AgentCatalogEntry {
  const install = installGuideFor(kind);
  return {
    kind,
    ...DEFAULT_LABELS[kind],
    command: DEFAULT_COMMANDS[kind],
    installCommand: install.command,
    installRunnable: Boolean(install.argv?.length),
    ...(install.hint ? { installHint: install.hint } : {}),
  };
}

/** 全部支持的 ACP agent 目录（管理后台展示 + 一键添加模板） */
export const AGENT_CATALOG: AgentCatalogEntry[] = ACP_AGENT_KINDS.map(catalogEntry);

/** persistent 会话默认空闲超时：30 分钟无消息 → 关闭进程（状态保留，可续聊） */
export const DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * acpx 持久会话「恢复失败」错误判定（acpx 抛 SessionResumeRequiredError，
 * 消息形如 `Persistent ACP session xxx could not be resumed: <reason>`）。
 */
function isSessionRecoveryRequiredError(err: unknown): boolean {
  return err instanceof Error && /could not be resumed/i.test(err.message);
}

export interface AcpEngineOptions {
  /** agent 逻辑 id（对外 id / 会话 key 前缀） */
  id: string;
  /** ACP agent key（registry override 与 probe 名） */
  agentName: AcpAgentKind;
  /** acpx 会话状态持久目录（跨进程恢复会话用） */
  stateDir: string;
  /** 启动命令；缺省按 agentName 的内置默认 */
  command?: string[];
  /** agent 默认工作目录：会话未显式传 cwd 时用它；缺省空串（沿用进程 cwd） */
  defaultCwd?: string;
  displayName?: string;
  description?: string;
  /** 透传 ACP 权限模式；默认 approve-reads */
  permissionMode?: AgentDefinition['permissionMode'];
  /**
   * ACP 工具权限策略（按工具名匹配，优先于 permissionMode）。
   * 挂在本机 agent 定义层，所有渠道（/v1、微信/企微 bot、openclaw 插件任务）共用同一策略。
   */
  permissionPolicy?: PermissionPolicySpec;
  /** 额外环境变量 */
  env?: Record<string, string>;
  verbose?: boolean;
  /** persistent 会话空闲超时（默认 30 分钟） */
  persistentIdleTimeoutMs?: number;
}

export type EngineTurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; name: string };

export interface RunTurnOptions {
  text: string;
  /** 持久会话 key：相同 key 复用同一 agent 会话（有记忆）；缺省一次性会话 */
  sessionKey?: string;
  /** 会话工作目录：优先于 engine defaultCwd */
  cwd?: string;
  /** 会话模型（经 ACP set_config_option 下发） */
  model?: string;
  /** 叠加到本次 spawn 的 env（默认任务 skill）；与 definition.env 合并，按用户隔离 runtime */
  env?: Record<string, string>;
  signal?: AbortSignal;
  onEvent?: (ev: EngineTurnEvent) => void;
}

export interface RunTurnResult {
  status: 'completed' | 'failed';
  error?: { message?: string };
  sessionId?: string;
}

type SessionHandle = Awaited<ReturnType<AcpxRuntime['ensureSession']>>;

/**
 * 与传输无关的本地 ACP 驱动引擎：封装 acpx runtime 的 ensureSession / setConfigOption /
 * startTurn / 事件收敛 / resume 重试 / 空闲关闭。本地 AcpWrapper 与远程节点连接器都复用它，
 * 保证「本机 spawn」与「节点机 spawn」是同一套会话生命周期逻辑。
 */
export class AcpEngine {
  readonly id: string;
  readonly agentName: AcpAgentKind;
  private readonly options: Required<Pick<AcpEngineOptions, 'stateDir'>> & AcpEngineOptions;
  private readonly runtimes = new Map<string, AcpxRuntime>();
  private readonly runtimeReady = new Map<string, Promise<AcpxRuntime>>();
  /** persistent 会话空闲定时器：sessionKey → 最近一次 handle + 倒计时 */
  private readonly persistentIdle = new Map<string, { handle: SessionHandle; timer: NodeJS.Timeout; runtime: AcpxRuntime }>();

  constructor(options: AcpEngineOptions) {
    this.options = options;
    this.id = options.id;
    this.agentName = options.agentName;
  }

  descriptor(): AgentDescriptor {
    const label = DEFAULT_LABELS[this.agentName];
    return {
      id: this.id,
      displayName: this.options.displayName ?? label.displayName,
      description: this.options.description ?? label.description,
    };
  }

  command(): string[] {
    return this.options.command ?? DEFAULT_COMMANDS[this.agentName];
  }

  /** 生效中的工具权限策略（definition 透传值；undefined = 跟随 permissionMode 兜底） */
  get permissionPolicy(): PermissionPolicySpec | undefined {
    return this.options.permissionPolicy;
  }

  /** engine 默认工作目录：options.defaultCwd（展开 ~），否则进程 cwd */
  private baseCwd(): string {
    const fallback = this.options.defaultCwd?.trim();
    return fallback ? resolveCwd(fallback) : process.cwd();
  }

  private runtimeSlot(extraEnv?: Record<string, string>): string {
    const user = extraEnv?.LINKAGENT_USER_ID?.trim();
    return user ? `skill:${user}` : '';
  }

  private getRuntime(extraEnv?: Record<string, string>): Promise<AcpxRuntime> {
    const slot = this.runtimeSlot(extraEnv);
    const existing = this.runtimes.get(slot);
    if (existing) return Promise.resolve(existing);
    let pending = this.runtimeReady.get(slot);
    if (!pending) {
      pending = this.initRuntime(extraEnv).then((rt) => {
        this.runtimes.set(slot, rt);
        this.runtimeReady.delete(slot);
        return rt;
      });
      this.runtimeReady.set(slot, pending);
    }
    return pending;
  }

  private async initRuntime(extraEnv?: Record<string, string>): Promise<AcpxRuntime> {
    const cwd = this.baseCwd();
    mkdirSync(this.options.stateDir, { recursive: true });
    const runtime = createAcpRuntime({
      cwd,
      agentProcessEnv: { ...this.options.env, ...extraEnv },
      sessionStore: createRuntimeStore({ stateDir: this.options.stateDir }),
      agentRegistry: createAgentRegistry({ overrides: { [this.agentName]: this.command() } }),
      permissionMode: this.options.permissionMode ?? 'approve-reads',
      nonInteractivePermissions: 'deny',
      permissionPolicy: this.options.permissionPolicy,
      probeAgent: this.agentName,
      verbose: this.options.verbose ?? false,
    });
    await runtime.probeAvailability();
    return runtime;
  }

  /**
   * 执行一轮对话。
   * - 有 sessionKey → persistent（进程常驻、同 key 复用、空闲超时关闭但状态保留）；
   * - 无 sessionKey → oneshot（每轮独立会话，用完即弃，避免记忆跨请求串扰）。
   */
  async runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
    const runtime = await this.getRuntime(opts.env);
    const requestId = randomUUID();
    const persistent = Boolean(opts.sessionKey?.trim());
    const sessionKey = persistent ? opts.sessionKey!.trim() : `gw-${this.id}-${requestId}`;
    const mode: 'persistent' | 'oneshot' = persistent ? 'persistent' : 'oneshot';
    const text = opts.text;
    const cwd = opts.cwd?.trim() ? resolveCwd(opts.cwd) : this.baseCwd();

    const attempt = async (resetFirst: boolean): Promise<RunTurnResult> => {
      if (resetFirst) {
        await this.dropRuntimeSessionRecord(sessionKey);
        opts.onEvent?.({ kind: 'text', text: '⚠️ 会话上下文已失效，已开启新会话（历史记忆不可用）。' });
      }

      let handle: SessionHandle;
      try {
        handle = await runtime.ensureSession({ sessionKey, agent: this.agentName, mode, cwd });
      } catch (err) {
        if (persistent && !resetFirst && isSessionRecoveryRequiredError(err)) return attempt(true);
        throw err;
      }

      if (opts.model) {
        const knownPi = this.agentName === 'pi' ? collectModelCandidates('pi') : [];
        const skipUnregisteredPi = this.agentName === 'pi' && (knownPi.length === 0 || !knownPi.includes(opts.model));
        if (skipUnregisteredPi) {
          opts.onEvent?.({
            kind: 'text',
            text: `⚠️ 未应用会话模型 ${opts.model}（不在本机 pi 已注册清单中）。模型由 pi/ACP 自己安装维护，请清空网关 agents[].model 或改成 models.json 里已有的 providerId/modelId。`,
          });
        } else {
          try {
            await runtime.setConfigOption({ handle, key: 'model', value: opts.model });
          } catch (err) {
            if (persistent && !resetFirst && isSessionRecoveryRequiredError(err)) return attempt(true);
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
              `设置会话模型“${opts.model}”失败（请确认该 agent 可用模型，或调整会话模型）：${detail}`,
              { cause: err },
            );
          }
        }
      }

      try {
        const turn = runtime.startTurn({
          handle,
          text,
          mode: 'prompt',
          requestId,
          signal: opts.signal,
          onElicitation: async () => ({ action: 'decline' }),
        });

        for await (const ev of turn.events) {
          if (ev.type === 'text_delta') {
            if (ev.stream === 'thought') opts.onEvent?.({ kind: 'thought', text: ev.text });
            else opts.onEvent?.({ kind: 'text', text: ev.text });
          } else if (ev.type === 'tool_call') {
            opts.onEvent?.({ kind: 'tool', name: ev.title ?? ev.text });
          }
        }

        const result = await turn.result;
        if (result.status === 'failed') {
          return { status: 'failed', error: { message: result.error?.message ?? 'agent 执行失败' }, sessionId: handle.acpxRecordId ?? handle.agentSessionId ?? undefined };
        }
        return { status: 'completed', sessionId: handle.acpxRecordId ?? handle.agentSessionId ?? undefined };
      } catch (err) {
        if (isAcpRuntimeError(err)) {
          const hint =
            err.code === 'ACP_BACKEND_UNAVAILABLE'
              ? `（确认本机已就绪 agent 启动命令：${this.command().join(' ')}）`
              : '';
          throw new Error(`ACP 运行时错误 [${err.code}]${hint}: ${err.message}`, { cause: err });
        }
        throw err;
      } finally {
        if (persistent) this.armPersistentIdle(runtime, handle);
        else await this.closeOneShot(runtime, handle);
      }
    };

    return attempt(false);
  }

  /** 便捷封装：从 OpenAI 多轮消息取最后 user 文本并执行（本地 wrapper 用） */
  async chatMessages(
    messages: Parameters<typeof lastUserText>[0],
    sessionKey: string | undefined,
    cwd: string | undefined,
    model: string | undefined,
    cb: {
      onText(delta: string): void;
      onReasoning?(delta: string): void;
      onToolActivity?(name: string): void;
      onSessionId?(sessionId: string): void;
    },
    signal?: AbortSignal,
    env?: Record<string, string>,
  ): Promise<{ sessionId?: string }> {
    const text = lastUserText(messages) ?? '';
    if (!text) throw new Error('请求中没有可发送的 user 文本（网关一期仅支持文本）');
    const result = await this.runTurn({
      text,
      sessionKey,
      cwd,
      model,
      ...(env ? { env } : {}),
      signal,
      onEvent: (ev) => {
        if (ev.kind === 'text') cb.onText(ev.text);
        else if (ev.kind === 'thought') cb.onReasoning?.(ev.text);
        else cb.onToolActivity?.(ev.name);
      },
    });
    if (result.status === 'failed') throw new Error(result.error?.message ?? 'agent 执行失败');
    if (result.sessionId) cb.onSessionId?.(result.sessionId);
    return { sessionId: result.sessionId };
  }

  private async closeOneShot(runtime: AcpxRuntime, handle: SessionHandle): Promise<void> {
    try {
      const closeSupported = Boolean(
        (handle as { agentCapabilities?: { sessionCapabilities?: { close?: unknown } } }).agentCapabilities?.sessionCapabilities?.close,
      );
      await runtime.close({
        handle,
        reason: 'request-complete',
        discardPersistentState: closeSupported,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[acp] oneshot 会话关闭失败 handle=${handle.acpxRecordId ?? handle.sessionKey}: ${detail}`);
    }
  }

  private async dropRuntimeSessionRecord(sessionKey: string): Promise<void> {
    try {
      const file = join(this.options.stateDir, 'sessions', `${encodeURIComponent(sessionKey)}.json`);
      rmSync(file, { force: true });
      console.warn(`[acp] 持久会话状态失效，已重置会话记录 sessionKey=${sessionKey}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[acp] 重置持久会话记录失败 sessionKey=${sessionKey}: ${detail}`);
    }
  }

  private armPersistentIdle(runtime: AcpxRuntime, handle: SessionHandle): void {
    const key = handle.sessionKey;
    const existing = this.persistentIdle.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.persistentIdle.delete(key);
      void runtime.close({ handle, reason: 'idle-timeout', discardPersistentState: false }).catch(() => {});
    }, this.options.persistentIdleTimeoutMs ?? DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS);
    timer.unref?.();
    this.persistentIdle.set(key, { handle, timer, runtime });
  }

  async dispose(): Promise<void> {
    for (const { handle, timer, runtime } of this.persistentIdle.values()) {
      clearTimeout(timer);
      await runtime.close({ handle, reason: 'dispose', discardPersistentState: false }).catch(() => {});
    }
    this.persistentIdle.clear();
    this.runtimes.clear();
    this.runtimeReady.clear();
  }
}
