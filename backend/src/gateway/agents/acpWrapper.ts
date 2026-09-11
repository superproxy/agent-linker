import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, isAcpRuntimeError, type AcpxRuntime } from 'acpx/runtime';
import type { AgentAdapter, AgentDefinition, AgentDescriptor, ChatRequest, ChatResult, StreamCallbacks } from '@linkagent/shared';
import { lastUserText } from '@linkagent/shared/opencode';

export type AcpAgentKind = AgentDefinition['type'];

/** 各 ACP agent 的默认启动命令（definition.command / options.command 可覆盖） */
const DEFAULT_COMMANDS: Record<AcpAgentKind, string[]> = {
  // --port 0：opencode acp 会读 opencode.json 的 server.port 并尝试绑定固定端口，
  // 多实例并发时后到者 ServeError 崩溃（实测根因）。--port 0 跳过固定端口绑定。
  opencode: ['opencode', 'acp', '--port', '0'],
  // pi 本身没有 ACP server：经官方收录的 pi-acp 桥接（内部 spawn `pi --mode rpc`）
  pi: ['npx', '-y', 'pi-acp'],
};

/** 各 ACP agent 的缺省展示信息（definition.displayName/description 可覆盖） */
const DEFAULT_LABELS: Record<AcpAgentKind, { displayName: string; description: string }> = {
  opencode: { displayName: 'OpenCode', description: '本地 opencode（ACP/acpx），默认只读问答' },
  pi: { displayName: 'Pi', description: '本地 pi（pi-coding-agent，经 pi-acp 桥接），默认只读问答' },
};

export interface AcpWrapperOptions {
  definition: AgentDefinition;
  /** ACP agent key（registry override 与 probe 名）；缺省取 definition.type */
  agentName?: AcpAgentKind;
  /** acpx 会话状态持久目录（跨进程恢复会话用） */
  stateDir: string;
  /** 启动命令；缺省按 agentName 的内置默认 */
  command?: string[];
  /** agent 默认工作目录：definition.cwd 未配时用它；缺省空串（沿用 process.cwd()） */
  defaultCwd?: string;
  verbose?: boolean;
  /**
   * persistent 会话（渠道多轮：微信/企微）的空闲超时：
   * 会话进程常驻（免冷启动），空闲超过该时长才关闭进程；会话状态始终保留，超时后同 sessionKey 可恢复续聊。
   * 默认 30 分钟。
   */
  persistentIdleTimeoutMs?: number;
}

/** persistent 会话默认空闲超时：30 分钟无消息 → 关闭进程（状态保留，可续聊） */
const DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * acpx 持久会话「恢复失败」错误判定（acpx 抛 SessionResumeRequiredError，
 * 消息形如 `Persistent ACP session xxx could not be resumed: <reason>`）。
 * 常见原因：agent 侧会话状态已失效（如 pi 按 cwd 清理旧会话文件、session-map 丢失），
 * 此时 acpx 的 resumePolicy=same-session-only 不会自动回退到新会话，需要调用方重置记录后新建。
 */
function isSessionRecoveryRequiredError(err: unknown): boolean {
  return err instanceof Error && /could not be resumed/i.test(err.message);
}

/**
 * ACP 后端适配器：直接以 acpx runtime 连接目标 agent 的 ACP server 进程
 * （opencode 原生 `opencode acp`；pi 经第三方 `pi-acp` 桥接到 `pi --mode rpc`）。
 *
 * 会话生命周期：
 * - oneshot（/v1 HTTP 无 sessionKey）：每请求独立会话，用完即弃，避免记忆跨请求串扰；
 * - persistent（渠道多轮，微信/企微带 sessionKey）：进程常驻于 acpx retained 池，
 *   同 sessionKey 下一轮免冷启动复用；仅空闲超过 persistentIdleTimeoutMs（默认 30 分钟）才关闭进程，
 *   会话状态始终保留在 stateDir，超时后同一 sessionKey 可恢复续聊。
 */
export class AcpWrapper implements AgentAdapter {
  readonly id: string;
  private readonly agentName: AcpAgentKind;
  private readonly definition: AgentDefinition;
  private readonly options: Required<Pick<AcpWrapperOptions, 'stateDir'>> & AcpWrapperOptions;
  private runtime: AcpxRuntime | null = null;
  private runtimeReady: Promise<AcpxRuntime> | null = null;
  /** 运行时模型覆盖（控制台切换）；undefined=沿用 definition.model */
  private modelOverride: string | undefined;
  /** persistent 会话空闲定时器：sessionKey → 最近一次使用的 handle + 空闲倒计时 */
  private readonly persistentIdle = new Map<string, { handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>; timer: NodeJS.Timeout }>();

  constructor(options: AcpWrapperOptions) {
    this.definition = options.definition;
    this.options = options;
    this.agentName = options.agentName ?? this.definition.type;
    this.id = options.definition.id;
  }

  /** agent 后端类型（opencode / pi） */
  get type(): AcpAgentKind {
    return this.agentName;
  }

  /** 当前生效的会话模型：运行时切换值优先，未切换则用 definition.model（可能 undefined=agent 默认） */
  get model(): string | undefined {
    return this.modelOverride ?? this.definition.model;
  }

  /** 热切换会话模型；null/空串/undefined 表示回到 definition.model */
  setModel(model: string | null | undefined): void {
    this.modelOverride = typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
  }

  descriptor(): AgentDescriptor {
    const label = DEFAULT_LABELS[this.agentName];
    return {
      id: this.definition.id,
      displayName: this.definition.displayName ?? label.displayName,
      description: this.definition.description ?? label.description,
    };
  }

  private command(): string[] {
    return this.definition.command ?? this.options.command ?? DEFAULT_COMMANDS[this.agentName];
  }

  /** agent 生效工作目录：definition.cwd 优先，否则 defaultCwd，否则网关启动目录 */
  private cwd(): string {
    const explicit = this.definition.cwd?.trim();
    if (explicit) return resolve(explicit);
    const fallback = this.options.defaultCwd?.trim();
    if (fallback) return resolve(fallback);
    return process.cwd();
  }

  private getRuntime(): Promise<AcpxRuntime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (!this.runtimeReady) {
      this.runtimeReady = this.initRuntime().then((rt) => {
        this.runtime = rt;
        this.runtimeReady = null;
        return rt;
      });
    }
    return this.runtimeReady;
  }

  private async initRuntime(): Promise<AcpxRuntime> {
    const cwd = this.cwd();
    mkdirSync(this.options.stateDir, { recursive: true });
    const runtime = createAcpRuntime({
      cwd,
      agentProcessEnv: this.definition.env,
      sessionStore: createRuntimeStore({ stateDir: this.options.stateDir }),
      agentRegistry: createAgentRegistry({ overrides: { [this.agentName]: this.command() } }),
      permissionMode: this.definition.permissionMode ?? 'approve-reads',
      nonInteractivePermissions: 'deny',
      probeAgent: this.agentName,
      verbose: this.options.verbose ?? false,
    });
    await runtime.probeAvailability();
    return runtime;
  }

  async chat(req: ChatRequest, cb: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    const runtime = await this.getRuntime();
    const requestId = randomUUID();
    // 有显式 sessionKey（渠道多轮会话：微信/企微等）→ persistent 复用同一 agent 会话（有记忆）；
    // 缺省（/v1 HTTP）→ oneshot 新会话用完即弃，避免 agent 记忆跨用户串扰
    const persistent = Boolean(req.sessionKey?.trim());
    const sessionKey = persistent ? req.sessionKey!.trim() : `gw-${this.id}-${requestId}`;
    const mode: 'persistent' | 'oneshot' = persistent ? 'persistent' : 'oneshot';

    const text = lastUserText(req.messages) ?? '';
    if (!text) throw new Error('请求中没有可发送的 user 文本（网关一期仅支持文本）');

    // 配置了会话模型时，先经 ACP set_config_option 指到指定模型（pi-acp 场景必需，
    // pi 自身默认 provider 可能无凭据；opencode 配置了也会生效，不配则不调用）
    const sessionModel = this.model;
    // 会话工作目录：任务级 cwd（ChatRequest.cwd）优先，否则 agent 默认 cwd（definition.cwd / defaultCwd / 网关启动目录）
    const cwd = req.cwd?.trim() ? resolve(req.cwd) : this.cwd();

    // 单次执行一轮。resetFirst=true 时先重置旧会话记录（后端侧会话状态已失效），同 sessionKey 新建会话。
    // 恢复失败仅允许在尚未开始流式输出时重试一次，避免重复输出。
    const attempt = async (resetFirst: boolean): Promise<ChatResult> => {
      if (resetFirst) {
        await this.dropRuntimeSessionRecord(sessionKey);
        cb.onText?.('⚠️ 会话上下文已失效，已开启新会话（历史记忆不可用）。');
      }

      let handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>;
      try {
        handle = await runtime.ensureSession({ sessionKey, agent: this.agentName, mode, cwd });
      } catch (err) {
        // 恢复旧持久会话失败（agent 侧会话状态丢失，如 pi 清理旧会话文件）→ 重置记录并新建会话续聊
        if (persistent && !resetFirst && isSessionRecoveryRequiredError(err)) return attempt(true);
        throw err;
      }

      if (sessionModel) {
        try {
          await runtime.setConfigOption({ handle, key: 'model', value: sessionModel });
        } catch (err) {
          // 恢复动作实际发生在 setConfigOption 内部（lazy 连后端），同样按上述规则重置重试
          if (persistent && !resetFirst && isSessionRecoveryRequiredError(err)) return attempt(true);
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `设置会话模型“${sessionModel}”失败（请确认该 agent 可用模型，或调整会话模型）：${detail}`,
            { cause: err },
          );
        }
      }

      try {
        const turn = runtime.startTurn({
          handle,
          text,
          mode: 'prompt',
          requestId,
          signal,
          onElicitation: async () => ({ action: 'decline' }),
        });

        for await (const ev of turn.events) {
          if (ev.type === 'text_delta') {
            if (ev.stream === 'thought') cb.onReasoning?.(ev.text);
            else cb.onText(ev.text);
          } else if (ev.type === 'tool_call') {
            cb.onToolActivity?.(ev.title ?? ev.text);
          }
          // status / done / error 通过 turn.result 收敛，不在此处理
        }

        const result = await turn.result;
        if (result.status === 'failed') {
          const msg = result.error?.message ?? 'agent 执行失败';
          throw new Error(msg);
        }
        cb.onSessionId?.(handle.acpxRecordId ?? handle.agentSessionId ?? requestId);
        return {};
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
        if (persistent) {
          // persistent 会话（渠道多轮：微信/企微）：进程保留在 acpx retained 池，
          // 同 sessionKey 下一轮免冷启动直接复用；仅空闲超时（默认 30 分钟）才关闭进程。
          // 会话状态始终保留（stateDir），超时关闭后同一 sessionKey 可恢复续聊。
          this.armPersistentIdle(handle);
        } else {
          // oneshot（/v1 HTTP，无 sessionKey）：用完即弃，避免 agent 记忆跨请求串扰
          await this.closeOneShot(runtime, handle);
        }
      }
    };

    return attempt(false);
  }

  /**
   * oneshot 会话关闭：优先 discardPersistentState=true（后端支持 ACP session/close 时
   * 明确丢弃后端会话状态，防记忆跨请求串扰）。
   *
   * pi-acp 等后端未实现 session/close：acpx close() 会在标记记录 closed 前抛
   * ACP_BACKEND_UNSUPPORTED_CONTROL，导致 oneshot 记录永远 closed=False（实测 67/67）
   * 且每轮静默抛错。检测到不支持时退回 discardPersistentState=false —— 同样经
   * closeRetainedSessionOwner→stopSessionOwner→client.close() 释放进程/连接，且正常标记
   * 记录 closed；oneshot sessionKey 每次唯一（gw-<id>-<uuid>），残留后端状态不会被复用。
   * 任何关闭失败记录日志，不再静默吞掉。
   */
  private async closeOneShot(runtime: AcpxRuntime, handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>): Promise<void> {
    try {
      // handle 实为 acpx 的 SessionRecord（运行时含 agentCapabilities；公开类型未声明，安全断言读取）
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

  /**
   * 删除 acpx 中该 sessionKey 的持久会话记录（stateDir/sessions/<encodeURIComponent(sessionKey)>.json）。
   * 用于 agent 侧会话状态已失效（无法恢复）时重置记录，使同一 sessionKey 后续请求新建会话续聊。
   * 删除失败仅记录日志，不影响主流程（后续 ensureSession 会重新创建记录）。
   */
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

  /**
   * 重置/登记 persistent 会话的空闲倒计时：进程常驻，空闲超时后调用 runtime.close
   * 释放进程（discardPersistentState=false → 会话状态保留，下轮可恢复续聊）。
   */
  private armPersistentIdle(handle: Awaited<ReturnType<AcpxRuntime['ensureSession']>>): void {
    const key = handle.sessionKey;
    const existing = this.persistentIdle.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.persistentIdle.delete(key);
      // 空闲超时：关闭进程释放资源；状态保留，同一 sessionKey 后续消息可恢复
      void this.runtime?.close({ handle, reason: 'idle-timeout', discardPersistentState: false }).catch(() => {});
    }, this.options.persistentIdleTimeoutMs ?? DEFAULT_PERSISTENT_IDLE_TIMEOUT_MS);
    timer.unref?.(); // 不阻止网关进程退出
    this.persistentIdle.set(key, { handle, timer });
  }

  async dispose(): Promise<void> {
    // 关闭所有仍常驻的 persistent 会话进程（状态保留，重启后同 sessionKey 可恢复）
    for (const { handle, timer } of this.persistentIdle.values()) {
      clearTimeout(timer);
      await this.runtime?.close({ handle, reason: 'dispose', discardPersistentState: false }).catch(() => {});
    }
    this.persistentIdle.clear();
    // oneshot 模式无长驻会话，runtime 无后台进程需保留；仅清引用
    this.runtime = null;
  }
}

/** opencode 便捷子类：默认 ACP agent key 'opencode'（命令 opencode acp） */
export class OpencodeWrapper extends AcpWrapper {
  constructor(options: Omit<AcpWrapperOptions, 'agentName'>) {
    super({ ...options, agentName: 'opencode' });
  }
}

/** pi 便捷子类：默认 ACP agent key 'pi'（命令 npx -y pi-acp） */
export class PiWrapper extends AcpWrapper {
  constructor(options: Omit<AcpWrapperOptions, 'agentName'>) {
    super({ ...options, agentName: 'pi' });
  }
}
