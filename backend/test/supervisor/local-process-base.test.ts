import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASE,
  LS_LOCAL_BASE_KEY,
  isLoopbackBase,
  localProcessBase,
  rememberLocalBase,
} from '../../../web/src/lib/local-base.ts';

function memStore(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key() {
      return null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

test('isLoopbackBase：仅回环主机视为本机', () => {
  assert.equal(isLoopbackBase('http://127.0.0.1:8787'), true);
  assert.equal(isLoopbackBase('http://localhost:8787'), true);
  assert.equal(isLoopbackBase('http://[::1]:8787'), true);
  assert.equal(isLoopbackBase('http://192.168.1.10:8787'), false);
  assert.equal(isLoopbackBase('not-a-url'), false);
});

test('localProcessBase：与当前网关连接地址无关，优先页面同源回环', () => {
  const storage = memStore({ [LS_LOCAL_BASE_KEY]: 'http://127.0.0.1:9999' });
  assert.equal(localProcessBase('http://127.0.0.1:8787', storage), 'http://127.0.0.1:8787');
  assert.equal(localProcessBase('http://192.168.1.10:8787', storage), 'http://127.0.0.1:9999');
  assert.equal(localProcessBase('http://example.com', memStore()), DEFAULT_BASE);
});

test('rememberLocalBase：只记住回环地址', () => {
  const storage = memStore();
  rememberLocalBase('http://example.com:8787', storage);
  assert.equal(storage.getItem(LS_LOCAL_BASE_KEY), null);
  rememberLocalBase('http://127.0.0.1:8787/', storage);
  assert.equal(storage.getItem(LS_LOCAL_BASE_KEY), 'http://127.0.0.1:8787');
});
