import type { AgentPlugin } from '../plugin-manager.js';
import type { CommandType, FileEntry } from '../../protocol/index.js';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { join, parse } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const OS = process.platform as 'linux' | 'darwin' | 'win32';

const FileManagerPlugin: AgentPlugin = {
  name: 'file-manager',
  description: '远程文件管理插件，支持文件的增删改查、上传下载等操作',
  version: '1.0.0',
  supportedCommands: [
    'file:list', 'file:read', 'file:write', 'file:delete', 'file:rename', 'file:mkdir', 'file:stat'
  ] as CommandType[],

  async handleCommand(command: CommandType, params: Record<string, any>) {
    switch (command) {
      case 'file:list': {
        const { path = '.' } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const entries = readdirSync(absPath, { withFileTypes: true });
        return entries.map((entry): FileEntry => {
          const entryPath = join(absPath, entry.name);
          const stat = statSync(entryPath);
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            mode: stat.mode,
          };
        });
      }

      case 'file:stat': {
        const { path } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const stat = statSync(absPath);
        return {
          path: absPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          createdAt: stat.birthtimeMs,
          mode: stat.mode,
        };
      }

      case 'file:read': {
        const { path, encoding = 'base64' } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const content = readFileSync(absPath);
        return encoding === 'base64' ? content.toString('base64') : content.toString(encoding);
      }

      case 'file:write': {
        const { path, content, encoding = 'base64' } = params;
        const absPath = resolvePath(path);
        const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, encoding);
        writeFileSync(absPath, buffer);
        return { success: true, path: absPath, size: buffer.length };
      }

      case 'file:delete': {
        const { path } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        if (OS === 'win32') {
          await execAsync(`del /f /s /q "${absPath}"`);
        } else {
          await execAsync(`rm -rf "${absPath}"`);
        }
        return { success: true };
      }

      case 'file:rename': {
        const { oldPath, newPath } = params;
        const absOldPath = resolvePath(oldPath);
        const absNewPath = resolvePath(newPath);
        if (!existsSync(absOldPath)) throw new Error('Old path not found');
        renameSync(absOldPath, absNewPath);
        return { success: true, oldPath: absOldPath, newPath: absNewPath };
      }

      case 'file:mkdir': {
        const { path, recursive = true } = params;
        const absPath = resolvePath(path);
        mkdirSync(absPath, { recursive });
        return { success: true, path: absPath };
      }

      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  },

  testCases: [
    {
      name: '创建临时目录',
      command: 'file:mkdir',
      params: { path: '/tmp/vibecoding-test' },
      expect: (res) => res.success === true,
    },
    {
      name: '写入测试文件',
      command: 'file:write',
      params: { path: '/tmp/vibecoding-test/test.txt', content: Buffer.from('Hello World').toString('base64') },
      expect: (res) => res.success === true && res.size === 11,
    },
    {
      name: '读取测试文件',
      command: 'file:read',
      params: { path: '/tmp/vibecoding-test/test.txt' },
      expect: (res) => Buffer.from(res, 'base64').toString() === 'Hello World',
    },
    {
      name: '列出目录',
      command: 'file:list',
      params: { path: '/tmp/vibecoding-test' },
      expect: (res) => Array.isArray(res) && res.some((f: any) => f.name === 'test.txt'),
    },
    {
      name: '删除测试文件',
      command: 'file:delete',
      params: { path: '/tmp/vibecoding-test' },
      expect: (res) => res.success === true,
    },
  ],
};

function resolvePath(path: string): string {
  const root = parse(process.cwd()).root;
  const resolved = join(root, path);
  if (!resolved.startsWith(root)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

export default FileManagerPlugin;
