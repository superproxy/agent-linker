/**
 * OpenAI 多轮消息 → agent prompt 的文本化工具（opencode/acpx 通道共用）
 */

interface AnyMessage {
  role: string;
  content: unknown;
}

function asText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p): p is { type: 'text'; text: string } => !!p && (p as { type?: string }).type === 'text' && typeof (p as { text?: string }).text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/** 取出最后一条 user 消息文本（用于在已带历史的 agent 会话上追加） */
export function lastUserText(messages: AnyMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const text = asText(m.content);
    if (text) return text;
  }
  return undefined;
}

/** 全部消息序列化为含 User/Assistant 角色标注的文本（无状态会话的一次性完整上下文） */
export function messagesToText(messages: AnyMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!m) continue;
    const text = asText(m.content);
    if (!text) continue;
    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
    parts.push(`${label}: ${text}`);
  }
  return parts.join('\n\n');
}
