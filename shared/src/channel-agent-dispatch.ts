/** OpenClaw 插件 host ↔ 网关 /v1 的 agent 派发契约（channels 与 plugins 共用，不依赖 gateway 包） */

export interface ChannelAgentDispatchParams {
  agentId: string;
  sessionKey: string;
  accountId: string;
  text: string;
  attachments?: Array<{ name: string; mimeType: string; url: string }>;
  signal?: AbortSignal;
}

export interface ChannelAgentDispatch {
  chat(
    params: ChannelAgentDispatchParams,
    cb: {
      onText(delta: string): void;
      onReasoning?(delta: string): void;
      onToolActivity?(name: string): void;
    },
  ): Promise<void>;
}
