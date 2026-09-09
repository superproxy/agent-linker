/**
 * openclaw/plugin-sdk/core shim（openclaw/plugin-sdk/setup 同构）
 *
 * 插件（openclaw-compat）只从这里 import 少量工具函数，缺失时也会
 * catch 降级；这里提供完整实现，避免降级路径。
 */
import { pathToFileURL } from 'node:url';

function normalizeStringEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries ?? []) {
    const trimmed = String(e ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** 通配 allowFrom：保证包含 "*"（插件 pairing/allowFrom 共用） */
export function addWildcardAllowFrom(allowFrom) {
  const next = normalizeStringEntries(allowFrom ?? []);
  if (!next.includes('*')) next.push('*');
  return next;
}

/** 合并 allowFrom 条目（去重保序） */
export function mergeAllowFromEntries(current, additions) {
  return normalizeStringEntries([...(current ?? []), ...(additions ?? [])]);
}

const MIME_BY_MAGIC = [
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
  { mime: 'image/bmp', magic: [0x42, 0x4d] },
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'audio/mpeg', magic: [0x49, 0x44, 0x33] },
];

/** 按 magic bytes 探测常见媒体 mime */
export function detectMime(buffer, fallback = 'application/octet-stream') {
  if (!buffer || !buffer.length) return fallback;
  for (const entry of MIME_BY_MAGIC) {
    const len = entry.magic.length;
    if (buffer.length >= len && entry.magic.every((b, i) => buffer[i] === b)) {
      if (entry.mime === 'image/webp' && buffer.toString('ascii', 8, 12) !== 'WEBP') continue;
      return entry.mime;
    }
  }
  return fallback;
}

/** linkagent 不做本地媒体根目录（出站媒体走插件自带 Agent HTTP API / Bot WS） */
export function getDefaultMediaLocalRoots() {
  return [];
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
};

/** 下载远程媒体（agent 主动推送媒体时的出站来源） */
export async function loadOutboundMediaFromUrl({ url, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`loadOutboundMediaFromUrl: HTTP ${res.status} for ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || detectMime(buffer);
    const pathname = url.startsWith('file:') ? pathToFileURL(url).pathname : new URL(url).pathname;
    const fileName = decodeURIComponent(pathname.split('/').pop() || 'media');
    return { buffer, contentType, fileName };
  } finally {
    clearTimeout(timer);
  }
}

export default { addWildcardAllowFrom, mergeAllowFromEntries, detectMime, getDefaultMediaLocalRoots, loadOutboundMediaFromUrl };
