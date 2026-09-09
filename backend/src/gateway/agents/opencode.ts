import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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

export interface AcpAdapterOptions {
  definition: AgentDefinition;
  /** ACP agent key（registry override 与 probe 名）；缺省取 definition.type */
  agentName?: AcpAgentKind;
  /** acpx 会话状态持久目录（跨进程恢复会话用） */
  stateDir: string;
  /** 启动命令；缺省按 agentName 的内置默认 */
  command?: string[];
  verbose?: boolean;
}

/**
 * ACP 后端适配器：直接以 acpx runtime 连接目标 agent 的 ACP server 进程
 * （opencode 原生 `opencode acp`；pi 经第三方 `pi-acp` 桥接到 `pi --mode rpc`）。
 * 一期采用「每请求独立 oneshot ACP 会话」，客户端侧管理多轮历史，
 * 避免 agent 持久记忆跨用户/跨聊天串扰；进程冷启动延迟为已知代价。
 */
export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  private readonly agentName: AcpAgentKind;
  private readonly definition: AgentDefinition;
  private readonly options: Required<Pick<AcpAdapterOptions, 'stateDir'>> & AcpAdapterOptions;
  private runtime: AcpxRuntime | null = null;
  private runtimeReady: Promise<AcpxRuntime> | null = null;
  /** 运行时模型覆盖（控制台切换）；undefined=沿用 definition.model */
  private modelOverride: string | undefined;

  constructor(options: AcpAdapterOptions) {
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
    const cwd = this.definition.cwd ? resolve(this.definition.cwd) : process.cwd();
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
    const handle = await runtime.ensureSession({
      sessionKey: persistent ? req.sessionKey!.trim() : `gw-${this.id}-${requestId}`,
      agent: this.agentName,
      mode: persistent ? 'persistent' : 'oneshot',
      cwd: this.definition.cwd ? resolve(this.definition.cwd) : process.cwd(),
    });

    const text = lastUserText(req.messages) ?? '';
    if (!text) throw new Error('请求中没有可发送的 user 文本（网关一期仅支持文本）');

    // 配置了会话模型时，先经 ACP set_config_option 指到指定模型（pi-acp 场景必需，
    // pi 自身默认 provider 可能无凭据；opencode 配置了也会生效，不配则不调用）
    const sessionModel = this.model;
    if (sessionModel) {
      try {
        await runtime.setConfigOption({ handle, key: 'model', value: sessionModel });
      } catch (err) {
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
      // persistent 会话保留状态（进入 stateDir session store），供同一 sessionKey 续聊
      await runtime.close({ handle, reason: 'request-complete', discardPersistentState: !persistent }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    // oneshot 模式下无长驻会话，runtime 无后台进程需保留；仅清引用
    this.runtime = null;
  }
}

/** opencode 便捷子类：默认 ACP agent key 'opencode'（命令 opencode acp） */
export class OpencodeAdapter extends AcpAdapter {
  constructor(options: Omit<AcpAdapterOptions, 'agentName'>) {
    super({ ...options, agentName: 'opencode' });
  }
}

/** pi 便捷子类：默认 ACP agent key 'pi'（命令 npx -y pi-acp） */
export class PiAdapter extends AcpAdapter {
  constructor(options: Omit<AcpAdapterOptions, 'agentName'>) {
    super({ ...options, agentName: 'pi' });
  }
}
