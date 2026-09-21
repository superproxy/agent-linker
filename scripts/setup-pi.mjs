#!/usr/bin/env node
/**
 * 安装 pi / pi-acp，并生成 ~/.pi/agent 模型配置（不写明文密钥）。
 *
 *   pnpm setup:pi
 *   node scripts/setup-pi.mjs --skip-install --home <dir>/.pi
 *   node scripts/setup-pi.mjs --force --sandbox
 *
 * 模板：backend/config/pi-agent/*.template（独立包为 server/config/pi-agent/）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPT_DIR, '..');

export function parseSetupPiArgs(argv) {
  /** @type {{ skipInstall: boolean; force: boolean; sandbox: boolean; home?: string; templates?: string }} */
  const out = { skipInstall: false, force: false, sandbox: false };
  for (const a of argv) {
    if (a === '--skip-install') out.skipInstall = true;
    else if (a === '--force') out.force = true;
    else if (a === '--sandbox') out.sandbox = true;
    else if (a.startsWith('--home=')) out.home = a.slice('--home='.length);
    else if (a.startsWith('--templates=')) out.templates = a.slice('--templates='.length);
  }
  return out;
}

export function resolveTemplateDir(explicit) {
  if (explicit) return resolve(explicit);
  const candidates = [
    join(REPO, 'backend', 'config', 'pi-agent'),
    join(REPO, 'server', 'config', 'pi-agent'),
  ];
  const hit = candidates.find((d) => existsSync(join(d, 'models.json.template')));
  if (!hit) throw new Error(`找不到 models.json.template（试过 ${candidates.join('、')}）`);
  return hit;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * 合并 settings：缺省只补 defaultProvider / defaultModel，不覆盖主题、已装包。
 * force 时覆盖这两个字段，其余键保留。
 */
export function mergePiSettings(existing, patch, force) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const next = { ...base };
  if (force || typeof next.defaultProvider !== 'string' || next.defaultProvider.trim() === '') {
    next.defaultProvider = patch.defaultProvider;
  }
  if (force || typeof next.defaultModel !== 'string' || next.defaultModel.trim() === '') {
    next.defaultModel = patch.defaultModel;
  }
  return next;
}

/**
 * 把模板落到 pi agent 目录。
 * @returns {{ models: 'wrote' | 'kept'; settings: 'wrote' | 'merged'; agentDir: string }}
 */
export function applyPiAgentConfig({ agentDir, templateDir, force = false }) {
  mkdirSync(agentDir, { recursive: true });
  const modelsTpl = join(templateDir, 'models.json.template');
  const settingsTpl = join(templateDir, 'settings.json.template');
  if (!existsSync(modelsTpl) || !existsSync(settingsTpl)) {
    throw new Error(`模板不完整：需要 ${modelsTpl} 与 ${settingsTpl}`);
  }
  const modelsPath = join(agentDir, 'models.json');
  const settingsPath = join(agentDir, 'settings.json');
  const models = readJson(modelsTpl);
  const settingsPatch = readJson(settingsTpl);

  let modelsAction = 'kept';
  if (!existsSync(modelsPath) || force) {
    writeJson(modelsPath, models);
    modelsAction = 'wrote';
  }

  const existing = existsSync(settingsPath) ? readJson(settingsPath) : {};
  writeJson(settingsPath, mergePiSettings(existing, settingsPatch, force));
  return { models: modelsAction, settings: existsSync(settingsPath) ? 'merged' : 'wrote', agentDir };
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args) {
  const r = spawnSync(npmBin(), args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} 失败（exit ${r.status ?? 'null'}）`);
}

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0;
}

function installCli() {
  console.log('→ 安装 @earendil-works/pi-coding-agent');
  runNpm(['i', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent']);
  console.log('→ 安装 pi-acp');
  runNpm(['i', '-g', 'pi-acp']);
}

function installSandbox() {
  if (process.platform === 'win32') {
    console.warn('跳过沙箱：pi-sandbox 不支持 Windows，请在 Linux 云机上安装。');
    return;
  }
  const missing = ['rg', 'socat', 'bwrap'].filter((c) => !which(c));
  if (missing.length > 0) {
    console.warn(`沙箱系统依赖缺失：${missing.join(', ')}`);
    console.warn('Ubuntu/Debian：sudo apt-get install -y ripgrep socat bubblewrap');
    console.warn('装完后再跑：pi install npm:@erichll/pi-auto-review && pi install npm:@erichll/pi-sandbox');
    return;
  }
  const pi = spawnSync('pi', ['install', 'npm:@erichll/pi-auto-review'], { stdio: 'inherit' });
  if (pi.status !== 0) throw new Error('pi install pi-auto-review 失败');
  const sb = spawnSync('pi', ['install', 'npm:@erichll/pi-sandbox'], { stdio: 'inherit' });
  if (sb.status !== 0) throw new Error('pi install pi-sandbox 失败');
}

export function setupPi(opts) {
  const home = resolve(opts.home ?? join(homedir(), '.pi'));
  const agentDir = join(home, 'agent');
  const templateDir = resolveTemplateDir(opts.templates);
  if (!opts.skipInstall) installCli();
  const result = applyPiAgentConfig({ agentDir, templateDir, force: Boolean(opts.force) });
  if (opts.sandbox) installSandbox();
  return { home, ...result };
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return self === entry;
}

if (isMain()) {
  try {
    const opts = parseSetupPiArgs(process.argv.slice(2));
    const r = setupPi(opts);
    console.log(`pi 配置：${r.agentDir}`);
    console.log(`  models.json  ${r.models === 'wrote' ? '已写入' : '已存在（--force 可覆盖）'}`);
    console.log('  settings.json 已合并 defaultProvider / defaultModel');
    console.log('密钥：export ARK_API_KEY=你的火山方舟密钥（models.json 使用 ${ARK_API_KEY}，不要把明文写入仓库）');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
