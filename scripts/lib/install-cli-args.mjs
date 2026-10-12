import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultInstallRoot, resolveInstallDir } from './install-paths.mjs';

/**
 * @param {string[]} argv
 * @param {{ extras?: string[] }} [opts]  允许的额外开关（如 --restart）
 */
export function parseInstallCliArgs(argv, opts = {}) {
  const extras = new Set(opts.extras ?? []);
  /** @type {Record<string, boolean>} */
  const flags = {};
  /** @type {string | undefined} */
  let installDir;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      help = true;
      continue;
    }
    if (a === '--install-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new InstallCliError('缺少 --install-dir 后的路径');
      }
      installDir = next;
      i++;
      continue;
    }
    if (a.startsWith('--install-dir=')) {
      const v = a.slice('--install-dir='.length).trim();
      if (!v) throw new InstallCliError('--install-dir= 需要非空路径');
      installDir = v;
      continue;
    }
    if (extras.has(a)) {
      flags[a] = true;
      continue;
    }
    if (a.startsWith('-')) {
      throw new InstallCliError(`未知参数: ${a}`);
    }
    throw new InstallCliError(`未知参数: ${a}`);
  }

  return { help, installDir, flags };
}

export class InstallCliError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InstallCliError';
  }
}

/**
 * CLI --install-dir > LINKAGENT_INSTALL > .linkagent-install（可选）> 平台默认
 * @param {{ installDir?: string, repoRoot?: string, readInstallMarker?: boolean, env?: NodeJS.ProcessEnv }} o
 */
export function resolveTargetInstallDir(o = {}) {
  const env = o.env ?? process.env;
  const fromCli = o.installDir?.trim();
  if (fromCli) return resolve(fromCli);
  const fromEnv = env.LINKAGENT_INSTALL?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (o.readInstallMarker !== false && o.repoRoot) {
    const f = join(o.repoRoot, '.linkagent-install');
    if (existsSync(f)) {
      const line = readFileSync(f, 'utf8').trim().split(/\r?\n/)[0]?.trim();
      if (line) return resolve(line);
    }
  }
  return resolve(resolveInstallDir(env));
}

/** @param {string} scriptLabel  如 local-install-update.mjs */
export function printInstallDirEnvHint(scriptLabel) {
  const def = defaultInstallRoot();
  console.log(`用法: node scripts/${scriptLabel} [选项]

  build:dist → 同步到运行安装目录（保留已有 config、.runtime-state）。

选项:
  --install-dir <path>   部署目标目录（优先于 LINKAGENT_INSTALL）
  --skip-build           跳过 pnpm install / build:dist（需已有 dist/linkagent）
  --skip-deploy-npm      部署时不于安装目录执行 npm install
  -h, --help             显示本帮助

环境变量:
  LINKAGENT_INSTALL      目标安装目录（未传 --install-dir 时生效）
                         缺省：${def}
`);
}

export function printMigrateInstallConfigHelp() {
  const def = defaultInstallRoot();
  console.log(`用法: node scripts/migrate-install-config.mjs [选项]

  在 **clone 仓库根** 执行：把 config **补缺** 到外部安装目录，
  并写入仓库根 .linkagent-install（后续 local-install-update / pm 走该目录）。
  默认 **仅配置**、**不覆盖** 目标已有文件；冲突时以退出码 1 结束。

选项:
  --install-dir <path>   目标目录（优先于 LINKAGENT_INSTALL）
  --overwrite-config     覆盖已有 gateway/weixin/channels/node.yaml 与 pi-agent/
  --with-runtime         同时合并 .runtime-state（缺省不复制运行态）
  --overwrite-runtime    与 --with-runtime 联用，覆盖已有运行态路径
  --overwrite            覆盖配置；若含 --with-runtime 则也覆盖运行态
  --dry-run              仅打印将使用的目标路径
  -h, --help             显示本帮助

环境变量:
  LINKAGENT_INSTALL      目标绝对路径（缺省 ${def}）
  LINKAGENT_LEGACY_ROOT  额外来源（如曾在 dist/linkagent 内运行）

本机 Windows 示例（在仓库根）:
  node scripts/migrate-install-config.mjs --install-dir=%USERPROFILE%\\agent-linker
  pnpm local:install-update
  cd %USERPROFILE%\\agent-linker && start.bat start

  安装目录已有 template 生成的 yaml，需改用仓库里调好的配置：
  node scripts/migrate-install-config.mjs --overwrite-config

  **服务器从旧整包迁出（含登录态）**：pnpm migrate:server（内部带 --with-runtime）
`);
}

/** @deprecated 旧名，请用 printMigrateInstallConfigHelp */
export function printMigrateCopyInstallHelp() {
  printMigrateInstallConfigHelp();
}
