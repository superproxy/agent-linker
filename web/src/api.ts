/** 网关客户端：/healthz + /v1/models + /v1/chat/completions (SSE 流式) */

export interface AgentInfo {
  id: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  object: string;
  description?: string;
}

export interface HealthInfo {
  ok: boolean;
  agents: AgentInfo[];
}

export interface ChatDelta {
  type: 'reasoning' | 'text' | 'done' | 'error';
  text?: string;
}

export class GatewayClient {
  constructor(private base: string) {}

  private url(path: string): string {
    return this.base.replace(/\/$/, '') + path;
  }

  async health(): Promise<HealthInfo> {
    const res = await fetch(this.url('/healthz'));
    if (!res.ok) throw new Error(`healthz ${res.status}`);
    return (await res.json()) as HealthInfo;
  }

  async models(): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/v1/models'));
    if (!res.ok) throw new Error(`/v1/models ${res.status}`);
    const data = (await res.json()) as { data: ModelInfo[] };
    return data.data;
  }

  /** 流式对话：逐条产出 reasoning / text / done 增量 */
  async *streamChat(
    model: string,
    messages: { role: string; content: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<ChatDelta> {
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat ${res.status} ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const emit = (raw: string): ChatDelta | null => {
      const line = raw.replace(/^data: /, '').trim();
      if (!line) return null;
      if (line === '[DONE]') return { type: 'done' };
      try {
        const json = JSON.parse(line) as {
          choices?: { delta?: { reasoning_content?: string; content?: string }; finish_reason?: string | null }[];
          error?: { message?: string };
        };
        if (json.error?.message) return { type: 'error', text: json.error.message };
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) return { type: 'reasoning', text: delta.reasoning_content };
        if (delta?.content) return { type: 'text', text: delta.content };
        if (json.choices?.[0]?.finish_reason === 'stop') return { type: 'done' };
        return null;
      } catch {
        return null;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const d = emit(part);
        if (d) yield d;
      }
    }
    if (buf.trim()) {
      const d = emit(buf);
      if (d) yield d;
    }
  }
}
