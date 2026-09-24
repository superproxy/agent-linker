export function convertMarkdownTables(markdown) {
  return markdown;
}

export function sanitizeAssistantVisibleText(text) {
  return text;
}

export function chunkTextForOutbound(text) {
  return text ? [String(text)] : [];
}

export function stripReasoningTagsFromText(text) {
  return typeof text === 'string' ? text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : text;
}

export function markdownToIRWithMeta(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }
