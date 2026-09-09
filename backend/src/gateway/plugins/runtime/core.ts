/**
 * PluginRuntime（core）—— host 注入插件的运行时面（openclaw 语义的精简实现）
 *
 * 插件通过 createPluginRuntimeStore() 取回本对象，调用 core.channel.*
 * 完成消息路由 / 会话 / 派发；target.runtime.log/error 打日志。
 */
import { chunkText, chunkMarkdownText, convertMarkdownTables, resolveMarkdownTableMode } from './channel/text.js';
import { createChannelSessionStore } from './channel/session.js';
import { createChannelMediaStore } from './channel/media.js';
import { buildAgentSessionKey, resolveAgentRoute } from './channel/routing.js';
import {
  hasControlCommand,
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
  shouldComputeCommandAuthorized,
} from './channel/commands.js';
import { createChannelPairingStore } from './channel/pairing.js';
import {
  createReplyDispatcherWithTyping,
  dispatchReplyFromConfig,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
  resolveHumanDelayConfig,
  withReplyDispatcher,
  type ChannelAgentDispatch,
  type ReplyDispatcher,
} from './channel/reply.js';
import { setConfigRuntimeHostWrite } from 'openclaw/plugin-sdk/config-runtime';

export interface RuntimeLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface PluginRuntimeDeps {
  stateDir: string;
  /** openclaw 兼容配置（channels/tools/agents/session 等） */
  config: Record<string, unknown>;
  logger: RuntimeLogger;
  /** agent 调度桥（linkagent AgentManager + AcpAdapter） */
  agentDispatch: ChannelAgentDispatch;
  /** writeConfigFile 是否真实写回 gateway.yaml；缺省仅内存合并 */
  persistConfig?: (next: Record<string, unknown>) => boolean | Promise<boolean>;
}

export interface PluginRuntime {
  version: string;
  log(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  config: {
    loadConfig(): Record<string, unknown>;
    writeConfigFile(next: Record<string, unknown>): Promise<void>;
  };
  channel: {
    text: {
      chunkText(text: string, limit?: number): string[];
      chunkMarkdownText(text: string, limit?: number): string[];
      resolveMarkdownTableMode(params: unknown): string;
      convertMarkdownTables(markdown: string, mode: string): string;
    };
    reply: {
      resolveEnvelopeFormatOptions(cfg?: unknown): { timezone?: string; includeTimestamp: boolean; includeElapsed: boolean; userTimezone?: string };
      formatAgentEnvelope(params: Record<string, unknown>): string;
      finalizeInboundContext<T extends Record<string, unknown>>(ctx: T, opts?: unknown): T;
      resolveHumanDelayConfig(cfg?: unknown, agentId?: string): number;
      createReplyDispatcherWithTyping(params: Record<string, unknown>): {
        dispatcher: ReplyDispatcher;
        replyOptions: Record<string, unknown>;
        markDispatchIdle(): void;
      };
      withReplyDispatcher<T>(params: Record<string, unknown>): Promise<T>;
      dispatchReplyFromConfig(params: Record<string, unknown>): Promise<{ delivered: boolean }>;
      dispatchReplyWithBufferedBlockDispatcher(params: Record<string, unknown>): Promise<{ delivered: boolean }>;
    };
    routing: {
      resolveAgentRoute(params: Record<string, unknown>): Record<string, unknown>;
      buildAgentSessionKey(params: Record<string, unknown>): string;
    };
    session: {
      resolveStorePath(configured?: unknown, opts?: { agentId?: string }): string;
      recordInboundSession(params: Record<string, unknown>): void;
      readSessionUpdatedAt(params: { storePath: string; sessionKey: string }): number | undefined;
    };
    media: {
      saveMediaBuffer(buffer: Buffer, contentType: string, kind?: string, maxBytes?: number, fileName?: string): {
        path: string;
        contentType: string;
        bytesSaved: number;
      };
      fetchRemoteMedia(params: { url: string; timeoutMs?: number }): Promise<{
        buffer: Buffer;
        contentType: string;
        fileName: string;
      }>;
    };
    commands: {
      shouldComputeCommandAuthorized(text: string, cfg?: unknown, options?: unknown): boolean;
      hasControlCommand(text: string, cfg?: unknown): boolean;
      resolveCommandAuthorizedFromAuthorizers(params: Record<string, unknown>): boolean;
      resolveControlCommandGate(params: Record<string, unknown>): { commandAuthorized: boolean; shouldBlock: boolean };
    };
    pairing: {
      readAllowFromStore(params: Record<string, unknown>): Array<{ id: string; name?: string; kind?: string }>;
      upsertPairingRequest(params: Record<string, unknown>): { code: string; created: boolean; existing?: boolean };
      approvePairingRequest(params: Record<string, unknown>): boolean;
    };
  };
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  const { stateDir, logger } = deps;
  const sessionStore = createChannelSessionStore(stateDir);
  const mediaStore = createChannelMediaStore(stateDir);
  const pairingStore = createChannelPairingStore(stateDir);
  const configRef = deps.config;

  // config-runtime（微信插件 lazy import 的 writeConfigFile）写入后同步到内存配置视图 + 落盘
  setConfigRuntimeHostWrite(async (next) => {
    Object.assign(configRef, next);
    if (deps.persistConfig) {
      const ok = await deps.persistConfig(next);
      if (!ok) logger.warn('[plugin-runtime] config-runtime 写入已同步内存，未落盘 gateway.yaml');
    }
  });

  const core: PluginRuntime = {
    version: '2026.9.3-linkagent',
    log(msg, ...args) {
      logger.info(msg, ...args);
    },
    error(msg, ...args) {
      logger.error(msg, ...args);
    },
    warn(msg, ...args) {
      logger.warn(msg, ...args);
    },
    info(msg, ...args) {
      logger.info(msg, ...args);
    },
    debug(msg, ...args) {
      logger.debug(msg, ...args);
    },
    config: {
      loadConfig() {
        return { ...configRef };
      },
      async writeConfigFile(next) {
        Object.assign(configRef, next);
        if (deps.persistConfig) {
          const ok = await deps.persistConfig(next);
          if (!ok) logger.warn('[plugin-runtime] writeConfigFile 已合并到内存，未落盘 gateway.yaml');
        } else {
          logger.warn('[plugin-runtime] writeConfigFile 仅更新内存配置（未配置持久化）');
        }
      },
    },
    channel: {
      text: {
        chunkText,
        chunkMarkdownText,
        resolveMarkdownTableMode(params) {
          const p = (params ?? {}) as { channel?: string; accountId?: string; cfg?: unknown; supportsBlockTables?: boolean };
          return resolveMarkdownTableMode(p);
        },
        convertMarkdownTables(markdown, mode) {
          return convertMarkdownTables(markdown, mode as never);
        },
      },
      reply: {
        resolveEnvelopeFormatOptions,
        formatAgentEnvelope(params) {
          return formatAgentEnvelope(params as never);
        },
        finalizeInboundContext(ctx, opts) {
          return finalizeInboundContext(ctx, opts as never);
        },
        resolveHumanDelayConfig(cfg, agentId) {
          return resolveHumanDelayConfig(cfg, agentId);
        },
        createReplyDispatcherWithTyping(params) {
          return createReplyDispatcherWithTyping(params as never);
        },
        withReplyDispatcher(params) {
          return withReplyDispatcher(params as never);
        },
        dispatchReplyFromConfig(params) {
          return dispatchReplyFromConfig(params as never, { agentDispatch: deps.agentDispatch });
        },
        dispatchReplyWithBufferedBlockDispatcher(params) {
          return dispatchReplyWithBufferedBlockDispatcher(
            params as unknown as Parameters<typeof dispatchReplyWithBufferedBlockDispatcher>[0],
            deps.agentDispatch,
          );
        },
      },
      routing: {
        resolveAgentRoute(params) {
          return resolveAgentRoute(params as never) as unknown as Record<string, unknown>;
        },
        buildAgentSessionKey(params) {
          return buildAgentSessionKey(params as never);
        },
      },
      session: {
        resolveStorePath: sessionStore.resolveStorePath.bind(sessionStore),
        recordInboundSession(params) {
          sessionStore.recordInboundSession({
            storePath: String(params.storePath),
            sessionKey: String(params.sessionKey),
            ctx: (params.ctx as Record<string, unknown>) ?? {},
            onRecordError: params.onRecordError as ((err: unknown) => void) | undefined,
          });
        },
        readSessionUpdatedAt: sessionStore.readSessionUpdatedAt.bind(sessionStore),
      },
      media: {
        saveMediaBuffer: mediaStore.saveMediaBuffer.bind(mediaStore),
        fetchRemoteMedia: mediaStore.fetchRemoteMedia.bind(mediaStore),
      },
      commands: {
        shouldComputeCommandAuthorized,
        hasControlCommand,
        resolveCommandAuthorizedFromAuthorizers(params) {
          return resolveCommandAuthorizedFromAuthorizers(params as never);
        },
        resolveControlCommandGate(params) {
          return resolveControlCommandGate(params as never);
        },
      },
      pairing: {
        readAllowFromStore(params) {
          return pairingStore.readAllowFromStore(params as never) as never;
        },
        upsertPairingRequest(params) {
          return pairingStore.upsertPairingRequest(params as never);
        },
        approvePairingRequest(params) {
          return pairingStore.approvePairingRequest(params as never);
        },
      },
    },
  };

  return core;
}
