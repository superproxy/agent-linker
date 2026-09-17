import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 文件名安全化：仅保留字母数字 . _ -，其余转义防路径注入 */
export function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 极简 JSON KV 存储：dir/<safe(key)>.json，tmp+rename 原子写。
 * 与 tasks/store 的写模式一致（读者永远看不到文件缺失/半写窗口），损坏文件读取返回 null。
 */
export interface KvJsonStore<T> {
  get(key: string): T | null;
  put(key: string, value: T): void;
  delete(key: string): void;
  /** 列出全部可解析记录（损坏文件跳过） */
  list(): T[];
}

export function createKvJsonStore<T>(dir: string): KvJsonStore<T> {
  const fileFor = (key: string) => join(dir, `${safeFileName(key)}.json`);
  return {
    get(key) {
      const file = fileFor(key);
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        return null;
      }
    },
    put(key, value) {
      mkdirSync(dir, { recursive: true });
      const file = fileFor(key);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, file);
    },
    delete(key) {
      rmSync(fileFor(key), { force: true });
    },
    list() {
      if (!existsSync(dir)) return [];
      const out: T[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        try {
          out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as T);
        } catch {
          // 损坏文件跳过
        }
      }
      return out;
    },
  };
}
