import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_TOP = new Set(['config', '.runtime-state']);

/** 发布包 → 安装目录（保留已有 config / .runtime-state） */
export function syncPublishToInstall(packageRoot, installRoot, { skipNpm = false } = {}) {
  if (!existsSync(join(packageRoot, '.linkagent-root'))) {
    throw new Error(`不是 linkagent 发布包：缺少 ${join(packageRoot, '.linkagent-root')}`);
  }
  const installCfg = join(installRoot, 'config');
  const installState = join(installRoot, '.runtime-state');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(installCfg, { recursive: true });
  mkdirSync(installState, { recursive: true });

  console.log(`→ 同步程序文件 → ${installRoot}（不覆盖 config、.runtime-state）`);
  for (const name of readdirSync(packageRoot)) {
    if (SKIP_TOP.has(name)) continue;
    if (name === 'node_modules' && skipNpm && existsSync(join(installRoot, 'node_modules'))) continue;
    const src = join(packageRoot, name);
    const dest = join(installRoot, name);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }

  const pkgCfg = join(packageRoot, 'config');
  if (existsSync(pkgCfg)) {
    for (const name of readdirSync(pkgCfg)) {
      if (!name.endsWith('.template')) continue;
      cpSync(join(pkgCfg, name), join(installCfg, name));
    }
  }

  if (!skipNpm || !existsSync(join(installRoot, 'node_modules'))) {
    console.log(`→ npm install --omit=dev（${installRoot}）`);
    const r = spawnSync(
      'npm',
      ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: installRoot, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (r.status !== 0) throw new Error('npm install 失败');
  }

  writeFileSync(join(installRoot, '.linkagent-root'), 'linkagent runtime install root\n', 'utf8');
}
