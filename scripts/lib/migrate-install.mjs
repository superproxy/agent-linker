import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CONFIG_FILES = ['gateway.yaml', 'weixin.yaml', 'channels.yaml', 'node.yaml'];

export function migrateConfigInto(destDir, sourceDirs) {
  mkdirSync(destDir, { recursive: true });
  for (const name of CONFIG_FILES) {
    const destFile = join(destDir, name);
    if (existsSync(destFile)) continue;
    for (const srcDir of sourceDirs) {
      if (!srcDir) continue;
      const srcFile = join(srcDir, name);
      if (existsSync(srcFile)) {
        cpSync(srcFile, destFile);
        console.log(`→ 配置：${srcFile} → ${destFile}`);
        break;
      }
    }
  }
  const destPi = join(destDir, 'pi-agent');
  if (!existsSync(destPi)) {
    for (const srcDir of sourceDirs) {
      if (!srcDir) continue;
      const srcPi = join(srcDir, 'pi-agent');
      if (existsSync(srcPi)) {
        cpSync(srcPi, destPi, { recursive: true });
        console.log(`→ 配置：${srcPi} → ${destPi}`);
        break;
      }
    }
  }
}

function walkRelative(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else out.push(rel.replace(/\\/g, '/'));
    }
  };
  if (existsSync(root)) walk(root, '');
  return out;
}

/** 仅复制目标尚不存在的路径（不覆盖） */
export function mergeRuntimeInto(destDir, sourceDirs) {
  mkdirSync(destDir, { recursive: true });
  for (const src of sourceDirs) {
    if (!src || !existsSync(src)) continue;
    console.log(`→ 合并运行态：${src} → ${destDir}`);
    for (const rel of walkRelative(src)) {
      const destPath = join(destDir, rel);
      if (existsSync(destPath)) continue;
      mkdirSync(dirname(destPath), { recursive: true });
      cpSync(join(src, rel), destPath);
    }
  }
}
