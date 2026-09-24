/** channels 进程内存日志环，用于推送到 gateway 供后台远程查看（企微/插件调试） */

const DEFAULT_MAX_LINES = 400;
const MAX_LINE_CHARS = 2000;

let maxLines = DEFAULT_MAX_LINES;
const lines: string[] = [];

function trimLine(raw: string): string {
  const one = raw.replace(/\r\n/g, '\n').split('\n').join(' ').trim();
  if (one.length <= MAX_LINE_CHARS) return one;
  return `${one.slice(0, MAX_LINE_CHARS)}…`;
}

export function setChannelGatewayLogBufferLimit(n: number): void {
  maxLines = Math.min(2000, Math.max(50, Math.floor(n)));
  while (lines.length > maxLines) lines.shift();
}

export function appendChannelGatewayLog(level: string, message: string, extras: string[] = []): void {
  const ts = new Date().toISOString();
  const tail = extras.length ? ` ${extras.join(' ')}` : '';
  lines.push(trimLine(`${ts} [${level}] ${message}${tail}`));
  while (lines.length > maxLines) lines.shift();
}

/** 最近 N 行（最旧在前） */
export function snapshotChannelGatewayLogs(tail = 200): string[] {
  const n = Math.min(maxLines, Math.max(1, Math.floor(tail)));
  if (lines.length <= n) return [...lines];
  return lines.slice(lines.length - n);
}

export function clearChannelGatewayLogBuffer(): void {
  lines.length = 0;
}
