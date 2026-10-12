#!/usr/bin/env node
/**
 * 从 *.template 生成 <安装根>/config/*.yaml（dev 仓库或 dist 独立包均可）。
 *
 *   bash scripts/config-init.sh [--force]
 *   node scripts/config-init.mjs [--force]
 *
 * 安装根：环境变量 LINKAGENT_HOME；或脚本上级目录含 .linkagent-root / pnpm-workspace.yaml。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function resolveInstallRoot() {
  const env = process.env.LINKAGENT_HOME?.trim();
  if (env) return resolve(env);
  let dir = resolve(SCRIPT_DIR, '..');
  if (existsSync(join(dir, '.linkagent-root')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    return dir;
  }
  return dir;
}

function resolveTemplatePath(installRoot, name) {
  const bases = [join(installRoot, 'backend', 'config'), join(installRoot, 'config')];
  for (const base of bases) {
    const p = join(base, `${name}.template`);
    if (existsSync(p)) return p;
  }
  return null;
}

const INSTALL_ROOT = resolveInstallRoot();
const OUT_DIR = join(INSTALL_ROOT, 'config');
const force = process.argv.includes('--force');

const FILES = ['gateway.yaml', 'weixin.yaml', 'channels.yaml', 'node.yaml'];

mkdirSync(OUT_DIR, { recursive: true });

for (const name of FILES) {
  const dest = join(OUT_DIR, name);
  if (existsSync(dest) && !force) {
    console.log(`跳过（已存在）：${dest}`);
    continue;
  }
  const template = resolveTemplatePath(INSTALL_ROOT, name);
  if (!template) {
    console.warn(`无模板：${name}.template（安装根 ${INSTALL_ROOT}）`);
    continue;
  }
  cpSync(template, dest);
  console.log(`已生成：${dest}`);
}

const piCandidates = [
  join(INSTALL_ROOT, 'backend', 'config', 'pi-agent'),
  join(INSTALL_ROOT, 'config', 'pi-agent'),
];
const piSrc = piCandidates.find((d) => existsSync(join(d, 'models.json.template')));
const piDest = join(OUT_DIR, 'pi-agent');
if (piSrc && (!existsSync(piDest) || force)) {
  cpSync(piSrc, piDest, { recursive: true });
  console.log(`已同步：${piDest}`);
}

console.log(`\n安装根：${INSTALL_ROOT}`);
console.log('配置目录：config/（yaml）；dist 运行时二进制在 bin/');
