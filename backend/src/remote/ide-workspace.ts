/**
 * 在线 IDE 工作区：只允许访问 baseDir 之内的路径。
 * 终端在该目录下启动 shell。默认工作区要求管理员；带 taskId 时根目录换成该任务的 cwd，任务归属人可访问。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const execFileAsync = promisify(execFile);

const MAX_TEXT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_BUFFER = 128 * 1024;

export class IdeWorkspaceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IdeWorkspaceError';
  }
}

export interface IdeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export function isInsideWorkspace(baseDir: string, absPath: string): boolean {
  const base = resolve(baseDir);
  const full = resolve(absPath);
  const rel = relative(base, full);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

function toRel(baseDir: string, absPath: string): string {
  const rel = relative(resolve(baseDir), resolve(absPath));
  if (!rel) return '';
  return rel.split(sep).join('/');
}

function logicalPath(baseDir: string, input: string | undefined): string {
  const raw = (input ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = resolve(baseDir, raw === '' ? '.' : raw);
  if (!isInsideWorkspace(baseDir, full)) {
    throw new IdeWorkspaceError('无权限访问该路径', 403, 'forbidden');
  }
  return full;
}

async function locate(baseDir: string, input: string | undefined, mustExist: boolean): Promise<string> {
  const full = logicalPath(baseDir, input);
  if (!existsSync(full)) {
    if (mustExist) throw new IdeWorkspaceError('路径不存在', 404, 'not_found');
    const parent = resolve(full, '..');
    if (!existsSync(parent)) throw new IdeWorkspaceError('上级目录不存在', 404, 'not_found');
    const realParent = await realpath(parent);
    if (!isInsideWorkspace(baseDir, realParent)) {
      throw new IdeWorkspaceError('无权限访问该路径', 403, 'forbidden');
    }
    return full;
  }
  const real = await realpath(full);
  if (!isInsideWorkspace(baseDir, real)) {
    throw new IdeWorkspaceError('无权限访问该路径', 403, 'forbidden');
  }
  return real;
}

function parentOf(rel: string): string | null {
  if (!rel) return null;
  const parent = posix.dirname(rel);
  return parent === '.' ? '' : parent;
}

export async function listWorkspace(baseDir: string, input: string | undefined): Promise<{
  path: string;
  parent: string | null;
  entries: IdeEntry[];
}> {
  const full = await locate(baseDir, input, true);
  const stat = await lstat(full);
  if (!stat.isDirectory()) throw new IdeWorkspaceError('不是目录', 400, 'not_directory');
  const names = await readdir(full);
  const entries: IdeEntry[] = [];
  for (const name of names) {
    const entryPath = resolve(full, name);
    try {
      const real = await realpath(entryPath);
      if (!isInsideWorkspace(baseDir, real)) continue;
      const info = await lstat(real);
      entries.push({
        name,
        path: toRel(baseDir, real),
        isDirectory: info.isDirectory(),
        size: info.size,
        modifiedAt: info.mtimeMs,
      });
    } catch {
      /* 跳过无法读取的项 */
    }
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const path = toRel(baseDir, full);
  return { path, parent: parentOf(path), entries };
}

export async function readWorkspaceFile(baseDir: string, input: string | undefined): Promise<{ path: string; content: string }> {
  const full = await locate(baseDir, input, true);
  const stat = await lstat(full);
  if (stat.isDirectory()) throw new IdeWorkspaceError('不能把目录当文件读取', 400, 'is_directory');
  if (stat.size > MAX_TEXT_BYTES) throw new IdeWorkspaceError('文件过大，无法在编辑器中打开', 413, 'too_large');
  const buf = await readFile(full);
  if (buf.includes(0)) throw new IdeWorkspaceError('不是文本文件', 415, 'not_text');
  return { path: toRel(baseDir, full), content: buf.toString('utf8') };
}

export async function writeWorkspaceFile(baseDir: string, input: string, content: string): Promise<{ path: string }> {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new IdeWorkspaceError('内容过大', 413, 'too_large');
  }
  const full = await locate(baseDir, input, false);
  if (existsSync(full)) {
    const stat = await lstat(full);
    if (stat.isDirectory()) throw new IdeWorkspaceError('不能把目录当文件写入', 400, 'is_directory');
  }
  await writeFile(full, content, 'utf8');
  return { path: toRel(baseDir, full) };
}

export async function mkdirWorkspace(baseDir: string, input: string): Promise<{ path: string }> {
  const full = logicalPath(baseDir, input);
  const parent = resolve(full, '..');
  if (!existsSync(parent)) throw new IdeWorkspaceError('上级目录不存在', 404, 'not_found');
  const realParent = await realpath(parent);
  if (!isInsideWorkspace(baseDir, realParent)) {
    throw new IdeWorkspaceError('无权限访问该路径', 403, 'forbidden');
  }
  await mkdir(full, { recursive: false });
  return { path: toRel(baseDir, full) };
}

export async function deleteWorkspacePath(baseDir: string, input: string): Promise<{ path: string }> {
  const relInput = (input ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relInput) throw new IdeWorkspaceError('不能删除工作区根目录', 400, 'invalid_path');
  const full = await locate(baseDir, input, true);
  const path = toRel(baseDir, full);
  if (!path) throw new IdeWorkspaceError('不能删除工作区根目录', 400, 'invalid_path');
  await rm(full, { recursive: true, force: false });
  return { path };
}

export async function runWorkspaceCommand(
  baseDir: string,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const trimmed = command.trim();
  if (!trimmed) throw new IdeWorkspaceError('命令为空', 400, 'empty_command');
  if (trimmed.length > 2000) throw new IdeWorkspaceError('命令过长', 400, 'command_too_long');
  if (trimmed.includes('\0')) throw new IdeWorkspaceError('命令无效', 400, 'invalid_command');
  const cwd = await realpath(baseDir);
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', trimmed] : ['-c', trimmed];
  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const failed = err as { stdout?: unknown; stderr?: unknown; code?: number; killed?: boolean; message?: string };
    if (failed.killed) throw new IdeWorkspaceError('命令超时', 408, 'timeout');
    if (failed.stdout !== undefined || failed.stderr !== undefined || typeof failed.code === 'number') {
      return {
        stdout: String(failed.stdout ?? ''),
        stderr: String(failed.stderr ?? ''),
        code: typeof failed.code === 'number' ? failed.code : 1,
      };
    }
    throw new IdeWorkspaceError(failed.message || '执行命令失败', 500, 'exec_failed');
  }
}

function sendError(reply: { code: (n: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof IdeWorkspaceError) {
    return reply.code(err.statusCode).send({ error: { message: err.message, code: err.code } });
  }
  const message = err instanceof Error ? err.message : '操作失败';
  return reply.code(500).send({ error: { message, code: 'internal' } });
}

export type IdeBaseDir = string | ((request: FastifyRequest) => string);

function resolveBase(base: IdeBaseDir, request: FastifyRequest): string {
  const dir = (typeof base === 'function' ? base(request) : base).trim();
  if (!dir) throw new IdeWorkspaceError('任务没有工作目录', 404, 'not_found');
  return dir;
}

export function registerIdeWorkspace(app: FastifyInstance, baseDir: IdeBaseDir): void {
  app.get('/files/list', async (request, reply) => {
    const path = (request.query as { path?: string }).path;
    try {
      return await listWorkspace(resolveBase(baseDir, request), path);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/files/content', async (request, reply) => {
    const path = (request.query as { path?: string }).path;
    try {
      return await readWorkspaceFile(resolveBase(baseDir, request), path);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/files/content', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string; content?: string };
    if (!body.path || typeof body.content !== 'string') {
      return reply.code(400).send({ error: { message: '缺少 path 或 content', code: 'invalid_body' } });
    }
    try {
      return await writeWorkspaceFile(resolveBase(baseDir, request), body.path, body.content);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/files/mkdir', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) return reply.code(400).send({ error: { message: '缺少 path', code: 'invalid_body' } });
    try {
      return await mkdirWorkspace(resolveBase(baseDir, request), body.path);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/files/delete', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string };
    if (!body.path) return reply.code(400).send({ error: { message: '缺少 path', code: 'invalid_body' } });
    try {
      return await deleteWorkspacePath(resolveBase(baseDir, request), body.path);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/terminal', async (request, reply) => {
    const body = (request.body ?? {}) as { command?: string };
    if (typeof body.command !== 'string') {
      return reply.code(400).send({ error: { message: '缺少 command', code: 'invalid_body' } });
    }
    try {
      return await runWorkspaceCommand(resolveBase(baseDir, request), body.command);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
