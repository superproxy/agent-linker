/**
 * OpenAI Chat Completions 兼容类型（我们只实现一期所需子集）
 * 网关对外表现为一个 OpenAI 兼容服务，WebUI（Chatbox/Open WebUI）直接对接。
 */

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  name?: string;
}

/** 客户端可传入 metadata.user 或 header x-session-id 标识会话 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  /**
   * linkagent 扩展字段（非 OpenAI 标准）：会话 key。
   * 相同 key 复用同一 agent 持久会话（有记忆），缺省则每次 oneshot。
   * 渠道 adapter（botAgent）用它把渠道会话 id 映射到网关会话。
   */
  sessionKey?: string;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      /** 兼容部分客户端对思考过程的展示 */
      reasoning_content?: string;
    };
    finish_reason: FinishReason;
  }>;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: FinishReason;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** SSE 文本行序列化：每个事件一行 data: + 空行结束 */
export function formatSseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** SSE 结束标记 */
export const SSE_DONE = 'data: [DONE]\n\n';
