#!/usr/bin/env node
/**
 * 从 backend/config/*.template 生成仓库根 config/*.yaml（dev 与 build:dist 共用）。
 *   pnpm config:init
 *   node scripts/config-init.mjs [--force]
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(REPO, 'backend', 'config');
const OUT_DIR = join(REPO, 'config');
const force = process.argv.includes('--force');

const FILES = ['gateway.yaml', 'weixin.yaml', 'channels.yaml', 'node.yaml'];

mkdirSync(OUT_DIR, { recursive: true });

for (const name of FILES) {
  const dest = join(OUT_DIR, name);
  if (existsSync(dest) && !force) {
    console.log(`跳过（已存在）：${dest}`);
    continue;
  }
  const template = join(TEMPLATE_DIR, `${name}.template`);
  if (!existsSync(template)) {
    console.warn(`无模板：${template}`);
    continue;
  }
  cpSync(template, dest);
  console.log(`已生成：${dest}`);
}

const piSrc = join(TEMPLATE_DIR, 'pi-agent');
const piDest = join(OUT_DIR, 'pi-agent');
if (existsSync(piSrc) && (!existsSync(piDest) || force)) {
  cpSync(piSrc, piDest, { recursive: true });
  console.log(`已同步：${piDest}`);
}

console.log('\n安装根布局：config/（yaml）、scripts/（运维脚本）、dist 内另有 bin/（esbuild 二进制）');
