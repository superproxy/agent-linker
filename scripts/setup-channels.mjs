#!/usr/bin/env node
/**
 * 安装 channel-gateway 所需的 OpenClaw 渠道插件（企微 / 飞书 / 微信扫码依赖）。
 * 插件已声明在 backend/package.json；本脚本执行 pnpm install 并校验包可解析。
 *
 *   pnpm setup:channels
 *   node scripts/setup-channels.mjs --skip-install
 *   node scripts/setup-channels.mjs --lark   # 额外安装 @larksuite/openclaw-lark（与 @openclaw/feishu 二选一使用时再装）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SCRIPT_DIR, '..');

/** 与 backend/package.json dependencies 对齐，供校验 */
export const DEFAULT_CHANNEL_PLUGINS = [
  '@wecom/wecom-openclaw-plugin',
  '@openclaw/feishu',
  '@tencent-weixin/openclaw-weixin',
];

export const LARK_FEISHU_PLUGIN = '@larksuite/openclaw-lark';

export function parseSetupChannelsArgs(argv) {
  /** @type {{ skipInstall: boolean; lark: boolean }} */
  const out = { skipInstall: false, lark: false };
  for (const a of argv) {
    if (a === '--skip-install') out.skipInstall = true;
    else if (a === '--lark' || a === '--with-lark') out.lark = true;
  }
  return out;
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（exit ${res.status ?? 1}）`);
  }
}

function installRootDeps(root) {
  const isDist = existsSync(join(root, '.linkagent-root'));
  if (isDist) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'], root);
    return;
  }
  run('pnpm', ['install'], root);
}

function addBackendOptional(root, packageName) {
  const isDist = existsSync(join(root, '.linkagent-root'));
  if (isDist) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['install', '--save', '--legacy-peer-deps', packageName], root);
    return;
  }
  run('pnpm', ['--filter', '@linkagent/backend', 'add', packageName], root);
}

/** @param {string} root @param {string} pkg npm 包名 */
export function findChannelPluginEntry(root, pkg) {
  const isDist = existsSync(join(root, '.linkagent-root'));
  const segments = pkg.split('/');
  const bases = isDist
    ? [join(root, 'node_modules', ...segments)]
    : [
        join(root, 'backend', 'node_modules', ...segments),
        join(root, 'node_modules', ...segments),
      ];
  const candidates = ['dist/index.js', 'dist/index.mjs', 'index.js', 'index.ts'];
  for (const base of bases) {
    for (const rel of candidates) {
      const p = join(base, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function canImportPackage(_root, pkg) {
  for (const spec of [pkg, `${pkg}/dist/index.js`]) {
    try {
      await import(spec);
      return true;
    } catch {
      /* 继续 */
    }
  }
  return false;
}

/**
 * @param {string} root 仓库根或 dist 包根
 * @param {string[]} packages
 */
export async function verifyChannelPlugins(root, packages) {
  const anchor = existsSync(join(root, '.linkagent-root'))
    ? join(root, 'package.json')
    : join(root, 'backend', 'package.json');
  if (!existsSync(anchor)) {
    throw new Error(`找不到 ${anchor}，请先 pnpm install`);
  }
  const missing = [];
  for (const pkg of packages) {
    const entry = findChannelPluginEntry(root, pkg);
    if (entry) {
      console.log(`  ✓ ${pkg} → ${entry}`);
      continue;
    }
    if (await canImportPackage(root, pkg)) {
      console.log(`  ✓ ${pkg}（import 可加载）`);
      continue;
    }
    missing.push(pkg);
    console.error(`  ✗ ${pkg} 未安装或无法解析`);
  }
  if (missing.length > 0) {
    throw new Error(`渠道插件缺失：${missing.join(', ')}；请执行 pnpm setup:channels（勿手动逐个 add）`);
  }
}

export function listPackagesFromBackendManifest(root) {
  const pkgPath = join(root, 'backend', 'package.json');
  if (!existsSync(pkgPath)) return [...DEFAULT_CHANNEL_PLUGINS];
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = pkg.dependencies ?? {};
  const out = DEFAULT_CHANNEL_PLUGINS.filter((name) => name in deps);
  return out.length > 0 ? out : [...DEFAULT_CHANNEL_PLUGINS];
}

/**
 * @param {{ skipInstall?: boolean; lark?: boolean; root?: string }} opts
 */
export async function setupChannels(opts = {}) {
  const root = resolve(opts.root ?? REPO_ROOT);
  const packages = listPackagesFromBackendManifest(root);
  if (opts.lark) packages.push(LARK_FEISHU_PLUGIN);

  if (!opts.skipInstall) {
    console.log('→ 安装 monorepo / 部署包依赖（含 OpenClaw 渠道插件）…');
    installRootDeps(root);
    if (opts.lark) {
      console.log(`→ 可选飞书官方插件 ${LARK_FEISHU_PLUGIN} …`);
      addBackendOptional(root, LARK_FEISHU_PLUGIN);
    }
  }

  console.log('→ 校验渠道插件可加载：');
  await verifyChannelPlugins(root, [...new Set(packages)]);
  return { root, packages: [...new Set(packages)] };
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return self === entry;
}

if (isMain()) {
  void (async () => {
    try {
      const opts = parseSetupChannelsArgs(process.argv.slice(2));
      await setupChannels(opts);
      console.log('\n渠道插件就绪。下一步：在后台配置企微/飞书并 pm restart channels。');
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  })();
}
