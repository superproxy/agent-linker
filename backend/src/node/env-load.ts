import { basename, join } from 'node:path';
import { applyDotenvFile } from '../config/dotenv-file.js';
import { getLayout } from '../install/layout.js';

/**
 * 独立节点启动前加载 env 文件（不覆盖进程已有变量）。
 * 顺序：安装根 node.env → .runtime-state/node.env → 命名实例 .runtime-state/node-<name>.env
 */
export function loadNodeConnectorEnvFiles(): void {
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
