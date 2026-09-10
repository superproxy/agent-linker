import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserTasks } from './types.js';

/** 用户状态文件名：<channel>.<userId>.json，特殊字符转义防路径注入 */
export function tasksFileFor(stateDir: string, channel: string, userId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe(channel)}.${safe(userId)}.json`);
}

export interface TaskStore {
  read(channel: string, userId: string): UserTasks | null;
  write(data: UserTasks): void;
}

export function createJsonStore(stateDir: string): TaskStore {
  return {
    read(channel, userId) {
      const file = tasksFileFor(stateDir, channel, userId);
      if (!existsSync(file)) return null;
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as UserTasks;
        if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return null;
        return data;
      } catch {
        return null; // 损坏：调用方按空状态重建
      }
    },
    write(data) {
      mkdirSync(stateDir, { recursive: true });
      const file = tasksFileFor(stateDir, data.channel, data.userId);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      rmSync(tmp, { force: true });
    },
  };
}
