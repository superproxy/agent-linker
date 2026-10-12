#!/usr/bin/env node
/**
 * 本机（含 Windows）：build:dist → 同步到运行安装目录。等同 server-install-update 的 build+deploy 段。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncPublishToInstall } from './lib/sync-install.mjs';
import {
  InstallCliError,
  parseInstallCliArgs,
  printInstallDirEnvHint,
  resolveTargetInstallDir,
} from './lib/install-cli-args.mjs';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const BUILD = join(ROOT, 'dist', 'linkagent');

let parsed;
try {
  parsed = parseInstallCliArgs(process.argv.slice(2), {
    extras: ['--skip-build', '--skip-deploy-npm', '--skip-install'],
  });
} catch (err) {
  if (err instanceof InstallCliError) {
    console.error(`${err.message}\n`);
    printInstallDirEnvHint('local-install-update.mjs');
    process.exit(1);
  }
  throw err;
}

if (parsed.help) {
  printInstallDirEnvHint('local-install-update.mjs');
  process.exit(0);
}

const skipBuild = Boolean(parsed.flags['--skip-build']);
const skipNpm = Boolean(parsed.flags['--skip-deploy-npm'] || parsed.flags['--skip-install']);

const install = resolveTargetInstallDir({
  installDir: parsed.installDir,
  repoRoot: ROOT,
  readInstallMarker: true,
});

console.log(`==> 构建产物：${BUILD}`);
console.log(`==> 部署目标：${install}`);

if (!skipBuild) {
  console.log('==> pnpm install');
  let r = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log('==> pnpm build:dist');
  const buildArgs = skipNpm ? ['build:dist', '--', '--skip-install'] : ['build:dist'];
  r = spawnSync('pnpm', buildArgs, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
} else if (!existsSync(join(BUILD, '.linkagent-root'))) {
  console.error('缺少 dist/linkagent，请先 build 或去掉 --skip-build');
  process.exit(1);
}

syncPublishToInstall(BUILD, install, { skipNpm });
writeFileSync(join(ROOT, '.linkagent-install'), `${install}\n`, 'utf8');
writeFileSync(join(ROOT, '.linkagent-server'), 'local\n', 'utf8');

console.log(`✅ 部署：${install}`);
console.log(`   启动：cd "${install}" && start.bat start（或 ./start.sh start）`);
