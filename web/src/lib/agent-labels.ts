/** 与网关 DEFAULT_LABELS 对齐的常见 agent 展示名（API 未带 displayName 时的兜底） */
const FALLBACK: Record<string, string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  workbuddy: 'WorkBuddy',
  'trace-cli': 'TraeCode CLI',
  cursor: 'Cursor',
  hermes: 'Hermes',
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
};

export function agentDisplayLabel(id: string, displayName?: string): string {
  const d = displayName?.trim();
  if (d) return d;
  const key = id.trim().toLowerCase();
  return FALLBACK[key] ?? id;
}
