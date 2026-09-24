/**
 * core.channel.media —— 入站媒体保存 / 远程媒体拉取
 *
 * 插件把企微传入的媒体（图片/语音/文件）解密为 buffer 后调用
 * saveMediaBuffer 落盘，再把本地路径交给 agent（视觉/多模态理解）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { detectMime } from './mime.js';

export interface MediaSaveResult {
  path: string;
  contentType: string;
  bytesSaved: number;
}

export interface MediaFetchResult {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

export interface ChannelMediaStore {
  saveMediaBuffer(
    buffer: Buffer,
    contentType: string,
    kind?: string,
    maxBytes?: number,
    fileName?: string,
  ): MediaSaveResult;
  fetchRemoteMedia(params: { url: string; timeoutMs?: number }): Promise<MediaFetchResult>;
  root: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
};

function extensionFor(contentType: string, fileName?: string): string {
  const fromName = fileName ? extname(fileName).toLowerCase() : '';
  if (fromName && /^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[contentType.split(';')[0]?.trim() ?? ''] ?? '.bin';
}

export function createChannelMediaStore(stateDir: string): ChannelMediaStore {
  const root = resolve(stateDir, 'media');
  mkdirSync(root, { recursive: true });
  return {
    root,
    saveMediaBuffer(buffer, contentType, _kind?, maxBytes?, fileName?) {
      const resolvedMime = contentType?.trim() || detectMime(buffer);
      let body = buffer;
      const limit = Number(maxBytes);
      if (Number.isFinite(limit) && limit > 0 && body.length > limit) {
        body = body.subarray(0, limit);
      }
      const name = `${Date.now()}-${randomUUID().slice(0, 8)}${extensionFor(resolvedMime, fileName)}`;
      const path = join(root, name);
      writeFileSync(path, body);
      return { path, contentType: resolvedMime, bytesSaved: body.length };
    },
    async fetchRemoteMedia({ url, timeoutMs = 15000 }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`fetchRemoteMedia: HTTP ${res.status} for ${url}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType =
          res.headers.get('content-type')?.split(';')[0]?.trim() || detectMime(buffer);
        const pathname = new URL(url).pathname;
        const fileName = decodeURIComponent(pathname.split('/').pop() || 'media');
        return { buffer, contentType, fileName };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
