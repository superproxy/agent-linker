/**
 * core.channel.text —— 文本分块 / markdown 表格处理（对齐 openclaw 语义的轻量实现）
 */

export type MarkdownTableMode = 'off' | 'bullets' | 'code' | 'block';

function normalizeChunkLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 20480;
  return Math.floor(n);
}

function safeBreakIndex(text: string, candidate: number, limit: number): number {
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > limit) return limit;
  // 避免把代理对（emoji 等）劈开
  const code = text.charCodeAt(candidate);
  return code >= 0xd800 && code <= 0xdbff && candidate + 1 < text.length ? candidate + 1 : candidate;
}

/** 按 limit 切块：优先在换行/空格断点（对齐 openclaw chunkTextByBreakResolver） */
export function chunkText(text: string, limit?: number): string[] {
  if (!text) return [];
  const normalizedLimit = normalizeChunkLimit(limit);
  if (normalizedLimit <= 0 || text.length <= normalizedLimit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > normalizedLimit) {
    const window = remaining.slice(0, normalizedLimit);
    const lastNewline = window.lastIndexOf('\n');
    const lastSpace = window.lastIndexOf(' ');
    const candidate = lastNewline > 0 ? lastNewline : lastSpace;
    const idx = safeBreakIndex(remaining, candidate, normalizedLimit);
    const chunk = remaining.slice(0, idx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    const brokeOnSeparator = idx < remaining.length && /\s/.test(remaining.charAt(idx));
    remaining = remaining.slice(Math.min(remaining.length, idx + (brokeOnSeparator ? 1 : 0))).trimStart();
  }
  const finalChunk = remaining.trimEnd();
  if (finalChunk.length) chunks.push(finalChunk);
  return chunks;
}

/** markdown 文本同样按 limit 切块（对齐 chunkTextForOutbound 的 md 版本，使用同一断点策略） */
export function chunkMarkdownText(text: string, limit?: number): string[] {
  return chunkText(text, limit);
}

function isMarkdownTableMode(value: unknown): value is MarkdownTableMode {
  return value === 'off' || value === 'bullets' || value === 'code' || value === 'block';
}

/** 从 cfg.channels[channel]（或 account 级）解析 markdown.tables 模式；默认 code */
export function resolveMarkdownTableMode(params: {
  channel?: string;
  accountId?: string;
  cfg?: unknown;
  supportsBlockTables?: boolean;
}): MarkdownTableMode {
  const channel = params.channel?.trim().toLowerCase() || '';
  const cfg = params.cfg as Record<string, unknown> | undefined;
  const channelsConfig = (cfg?.channels ?? {}) as Record<string, unknown>;
  const section = (channelsConfig[channel] ?? (cfg?.[channel] as unknown)) as
    | { markdown?: { tables?: unknown }; accounts?: Record<string, unknown> }
    | undefined;
  let resolved: MarkdownTableMode = 'code';
  if (section) {
    const accountId = (params.accountId ?? '').trim();
    const accountMatch = section.accounts?.[accountId] as { markdown?: { tables?: unknown } } | undefined;
    const accountMode = accountMatch?.markdown?.tables;
    if (isMarkdownTableMode(accountMode)) resolved = accountMode;
    else if (isMarkdownTableMode(section.markdown?.tables)) resolved = section.markdown.tables;
  }
  return resolved === 'block' && !params.supportsBlockTables ? 'code' : resolved;
}

/**
 * 把 markdown 表格转成目标模式。轻量实现：识别 GFM 表格块，
 * code → 包裹为代码块；bullets → 每行转列表项；block/off → 原样。
 */
export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === 'off' || !markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  const isTableLine = (line: string): boolean => /^\s*\|?[^|\n]*\|[^|\n]*\|?\s*$/.test(line);
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isTableLine(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const table: string[] = [];
      while (i < lines.length && isTableLine(lines[i] ?? '')) {
        table.push((lines[i] ?? '').trim());
        i += 1;
      }
      if (mode === 'code') {
        out.push('```');
        out.push(...table);
        out.push('```');
      } else if (mode === 'bullets') {
        // 表头 + 分隔行 + 数据行 => 数据行转列表，表头作说明
        const rows = table.filter((_, idx) => idx !== 1);
        const header = rows[0]?.replace(/^\||\|$/g, '').trim() ?? '';
        if (header) out.push(`表格字段：${header}`);
        for (const row of rows.slice(1)) {
          const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          out.push(`- ${cells.join(' / ')}`);
        }
      } else {
        out.push(...table);
      }
    } else {
      out.push(line);
      i += 1;
    }
  }
  return out.join('\n');
}
