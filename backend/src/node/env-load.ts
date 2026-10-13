import { basename, delimiter, join, resolve } from 'node:path';
import { applyDotenvFile } from '../config/dotenv-file.js';
import { getLayout } from '../install/layout.js';

function explicitEnvPathsFromProcess(): string[] {
  const list = process.env.LINKAGENT_NODE_ENV_FILES?.trim();
  if (list) {
    return list
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((p) => resolve(p));
  }
  const single = process.env.LINKAGENT_NODE_ENV_FILE?.trim();
  if (single) return [resolve(single)];
  return [];
}

/**
 * 独立节点启动前加载 env 文件（不覆盖进程已有变量）。
 * 指定 `-f` / LINKAGENT_NODE_ENV_FILE(S) 时**仅**加载这些文件（不再读默认 node.env）。
 * 否则顺序：安装根 node.env → .runtime-state/node.env → 命名实例 .runtime-state/node-<name>.env
 */
export function loadNodeConnectorEnvFiles(explicitFromArgv?: readonly string[]): void {
  const fromArgv = explicitFromArgv?.map((p) => resolve(p.trim())).filter((p) => p.length > 0) ?? [];
  const explicit = fromArgv.length > 0 ? fromArgv : explicitEnvPathsFromProcess();

  if (explicit.length > 0) {
    for (const p of explicit) applyDotenvFile(p);
    return;
  }

  const layout = getLayout();
  const paths: string[] = [join(layout.root, 'node.env'), join(layout.stateRoot, 'node.env')];

  const stateDir = process.env.LINKAGENT_NODE_STATE_DIR?.trim();
  if (stateDir) {
    const base = basename(stateDir);
    const named = join(layout.stateRoot, `${base}.env`);
    if (!paths.includes(named)) paths.push(named);
  }

  for (const p of paths) applyDotenvFile(p);
}
