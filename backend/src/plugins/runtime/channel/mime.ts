/**
 * 轻量 mime 探测（magic bytes），对齐 openclaw-shim core 的 detectMime。
 */
const MIME_BY_MAGIC: Array<{ mime: string; magic: number[] }> = [
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/bmp', magic: [0x42, 0x4d] },
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'audio/mpeg', magic: [0x49, 0x44, 0x33] },
];

export function detectMime(buffer: Buffer, fallback = 'application/octet-stream'): string {
  if (!buffer?.length) return fallback;
  for (const entry of MIME_BY_MAGIC) {
    const len = entry.magic.length;
    if (buffer.length >= len && entry.magic.every((b, i) => buffer[i] === b)) {
      if (entry.mime === 'image/webp' && buffer.toString('ascii', 8, 12) !== 'WEBP') continue;
      return entry.mime;
    }
  }
  return fallback;
}
