/**
 * openclaw/plugin-sdk/infra-runtime shim
 *
 * 微信插件从这里取：
 * - resolvePreferredOpenClawTmpDir()：临时目录（日志 / 媒体出站临时文件）
 * - withFileLock(path, options, fn)：文件锁（pairing 注册 allowFrom 用）
 *
 * 文件锁实现：进程内按路径串行化（单进程网关足够），不跨进程。
 */
import os from 'node:os';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 优先 OPENCLAW_TMP_DIR env，否则系统临时目录 */
export function resolvePreferredOpenClawTmpDir() {
  const env = process.env.OPENCLAW_TMP_DIR?.trim();
  if (env) return env;
  return os.tmpdir();
}

const queues = new Map();

/**
 * 简易文件锁：同路径的 fn 串行执行；参数签名对齐 openclaw
 * （options 接受 { retries, stale }，shim 忽略，仅保证互斥）。
 */
export async function withFileLock(filePath, _options, fn) {
  const prev = queues.get(filePath) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  queues.set(filePath, next);
  await prev.catch(() => {});
  try {
    // 确保锁文件所在目录存在（真实 openclaw 的 lockfile 写在该路径旁）
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // best-effort
    }
    return await fn();
  } finally {
    release();
    if (queues.get(filePath) === next) queues.delete(filePath);
  }
}

export default { resolvePreferredOpenClawTmpDir, withFileLock };
