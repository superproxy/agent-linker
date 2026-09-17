import type { UserPreference } from '../tasks/types.js';
import { createKvJsonStore, type KvJsonStore } from '../store/kv.js';

/** 用户偏好存储：.runtime-state/prefs/<channel>.<userId>.json */
export interface PreferenceStore {
  get(channel: string, userId: string): UserPreference | null;
  put(pref: UserPreference): void;
}

export function prefKey(channel: string, userId: string): string {
  return `${channel}.${userId}`;
}

export function createPreferenceStore(stateDir: string): PreferenceStore {
  const kv: KvJsonStore<UserPreference> = createKvJsonStore<UserPreference>(stateDir);
  return {
    get: (channel, userId) => kv.get(prefKey(channel, userId)),
    put: (pref) => kv.put(prefKey(pref.channel, pref.userId), pref),
  };
}
