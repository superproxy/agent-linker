import { randomUUID } from 'node:crypto';

const MAX_GATEWAY_TRACE_LINES = 400;
const gatewayLines: string[] = [];

let channelTraceSink: ((line: string) => void) | null = null;

export function newDispatchTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** 单行追踪：`step=… key=value`（不含时间戳，由 sink 加前缀） */
export function formatDispatchTraceLine(
  step: string,
  fields: Record<string, string | number | boolean | undefined>,
): string {
  const parts = [`step=${step}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value);
    parts.push(`${key}=${raw.length > 240 ? `${raw.slice(0, 240)}…` : raw}`);
  }
  return parts.join(' ');
}

function pushGatewayLine(line: string): void {
  gatewayLines.push(line);
  while (gatewayLines.length > MAX_GATEWAY_TRACE_LINES) gatewayLines.shift();
}

export function setChannelDispatchTraceSink(sink: ((line: string) => void) | null): void {
  channelTraceSink = sink;
}

export function emitChannelDispatchTrace(
  step: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  const line = formatDispatchTraceLine(step, fields);
  channelTraceSink?.(line);
}

export function emitGatewayDispatchTrace(
  step: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  pushGatewayLine(formatDispatchTraceLine(step, fields));
}

/** 将 channels 侧追踪行原样写入 gateway 环（调试用） */
export function appendGatewayDispatchTraceRaw(line: string): void {
  const trimmed = line.trim();
  if (trimmed) pushGatewayLine(trimmed);
}

export function snapshotGatewayDispatchTrace(tail = 200): string[] {
  const n = Math.min(MAX_GATEWAY_TRACE_LINES, Math.max(1, Math.floor(tail)));
  if (gatewayLines.length <= n) return [...gatewayLines];
  return gatewayLines.slice(gatewayLines.length - n);
}

export function clearGatewayDispatchTraceForTest(): void {
  gatewayLines.length = 0;
  channelTraceSink = null;
}
