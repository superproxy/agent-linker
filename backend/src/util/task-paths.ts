import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 展开路径中的用户主目录：Node 的 path.resolve 不会展开 `~`，
 * 用户在任务 cwd 里填 `~/test` 会被当成相对路径拼成 `<网关cwd>/~/test`（不存在）→ spawn ENOENT。
 * 支持 `~` 与 `~/xxx`（不展开 `~user` 其他用户形式）。
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** Windows 磁盘根目录（如 D:\\），在此 mkdir 常触发 EPERM */
export function isWindowsDriveRoot(p: string): boolean {
  if (platform() !== 'win32') return false;
  const n = p.replace(/\\/g, '/');
  return /^[a-zA-Z]:\/?$/.test(n);
}

function assertSafeTaskDirectory(cwd: string): void {
  if (isWindowsDriveRoot(cwd)) {
    throw new Error(
      `工作目录不能为磁盘根目录（${cwd}）。请填写完整路径，例如 D:\\projects\\my-workspace；` +
        '若仅写盘符 D:，在 Windows 上会被解析成磁盘根目录并导致创建失败。',
    );
  }
}

/** 解析工作目录：先展开 ~，再转绝对路径；拒绝 Windows 盘符-only / 磁盘根 */
export function resolveCwd(p: string): string {
  const raw = p.trim();
  if (!raw) {
    throw new Error('工作目录不能为空');
  }
  if (platform() === 'win32' && /^[a-zA-Z]:$/.test(raw)) {
    throw new Error(
      '工作目录不能仅为盘符（如 D:）。请填写完整路径，例如 D:\\projects\\my-workspace',
    );
  }
  const cwd = resolve(expandHome(raw));
  assertSafeTaskDirectory(cwd);
  return cwd;
}

/**
 * 任务工作空间路径拼接。
 * Windows 上 path.join('D:', 'user', 'task') 会得到盘符相对路径 D:user\\task，
 * 远程节点 resolve 后行为依赖进程 cwd；必须用 resolve 得到稳定的绝对路径。
 */
export function resolveTaskPath(...segments: string[]): string {
  const parts = segments.map((s) => expandHome(s.trim())).filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error('任务路径 segments 不能为空');
  const cwd = resolve(...parts);
  assertSafeTaskDirectory(cwd);
  return cwd;
}

/** config tasks.workspaceDir：转绝对路径并校验 */
export function resolveTaskWorkspaceRoot(root: string): string {
  const trimmed = root.trim();
  if (platform() === 'win32' && /^[a-zA-Z]:$/.test(trimmed)) {
    throw new Error(
      'tasks.workspaceDir 不能仅为盘符（如 D:）。请填写完整目录，例如 D:\\linkagent\\tasks-workspace',
    );
  }
  const abs = resolve(expandHome(trimmed));
  assertSafeTaskDirectory(abs);
  return abs;
}

/** 旧数据：Windows 上仅存 D: 或解析到磁盘根，会在节点 mkdir 时 EPERM */
export function isLegacyBrokenTaskCwd(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (platform() === 'win32' && /^[a-zA-Z]:$/.test(t)) return true;
  try {
    return isWindowsDriveRoot(resolve(expandHome(t)));
  } catch {
    return true;
  }
}

/** 执行端（节点/本机 agent）启动前补齐任务 cwd */
export function ensureTaskCwdExists(raw: string): string {
  const cwd = resolveCwd(raw);
  mkdirSync(cwd, { recursive: true });
  if (!existsSync(cwd)) {
    throw new Error(`任务工作目录创建后仍不存在: ${cwd}`);
  }
  return cwd;
}
