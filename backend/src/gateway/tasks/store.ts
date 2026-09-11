import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserTasks } from './types.js';

/** 用户摘要（用户列表页用：channel.userId + 任务数 + 最后活跃） */
export interface UserSummary {
  channel: string;
  userId: string;
  activeTaskId: string;
  taskCount: number;
  /** 文件 mtime（最近一次状态变更） */
  updatedAt: number;
}

/** 用户状态文件名：<channel>.<userId>.json，特殊字符转义防路径注入 */
export function tasksFileFor(stateDir: string, channel: string, userId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe(channel)}.${safe(userId)}.json`);
}

export interface TaskStore {
  read(channel: string, userId: string): UserTasks | null;
  write(data: UserTasks): void;
  /** 列出全部用户（含任务数，按最近活跃倒序） */
  list(): UserSummary[];
  /** 删除一个用户的全部状态 */
  remove(channel: string, userId: string): void;
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
      // 原子替换：读者永远看不到「文件缺失/半写」窗口。
      // 之前先 rmSync(file) 再 writeFileSync 会造成窗口期 read() 返回 null，
      // 调用方会重建仅含 default 的空白状态 → 切换任何真实任务都报「任务不存在」。
      renameSync(tmp, file);
    },
    list() {
      if (!existsSync(stateDir)) return [];
      const out: UserSummary[] = [];
      for (const f of readdirSync(stateDir)) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const file = join(stateDir, f);
        try {
          const data = JSON.parse(readFileSync(file, 'utf8')) as UserTasks;
          if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) continue;
          out.push({
            channel: data.channel,
            userId: data.userId,
            activeTaskId: data.activeTaskId,
            taskCount: data.tasks.length,
            updatedAt: statSync(file).mtimeMs,
          });
        } catch {
          continue; // 损坏文件跳过
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    remove(channel, userId) {
      rmSync(tasksFileFor(stateDir, channel, userId), { force: true });
    },
  };
}
