import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CONFIG_FILES = ['gateway.yaml', 'weixin.yaml', 'channels.yaml', 'node.yaml'];

/** 缺省的 split yaml 由同目录 *.template 生成（发布包/sync 常只带 template） */
export function materializeConfigFromTemplates(configDir) {
  mkdirSync(configDir, { recursive: true });
  for (const name of CONFIG_FILES) {
    const destFile = join(configDir, name);
    if (existsSync(destFile)) continue;
    const template = join(configDir, `${name}.template`);
    if (existsSync(template)) {
      cpSync(template, destFile);
      console.log(`→ 配置：由模板生成 ${destFile}`);
    }
  }
}

/**
 * @param {string} destDir
 * @param {string[]} sourceDirs
 * @param {{ overwriteConfig?: boolean }} [opts]
 * @returns {Array<{ kind: 'config', name: string, dest: string, src: string }>}
 */
export function migrateConfigInto(destDir, sourceDirs, opts = {}) {
  const overwrite = opts.overwriteConfig === true;
  /** @type {Array<{ kind: 'config', name: string, dest: string, src: string }>} */
  const conflicts = [];
  mkdirSync(destDir, { recursive: true });

  for (const name of CONFIG_FILES) {
    const destFile = join(destDir, name);
    let srcFile = null;
    for (const srcDir of sourceDirs) {
      if (!srcDir) continue;
      const candidate = join(srcDir, name);
      if (existsSync(candidate)) {
        srcFile = candidate;
        break;
      }
    }
    if (!srcFile) continue;

    if (existsSync(destFile)) {
      if (overwrite) {
        cpSync(srcFile, destFile);
        console.log(`→ 配置：覆盖 ${destFile} ← ${srcFile}`);
      } else {
        conflicts.push({ kind: 'config', name, dest: destFile, src: srcFile });
        console.warn(`⚠️  配置冲突：${name} 目标已存在，已跳过（使用 --overwrite-config 覆盖）`);
      }
      continue;
    }
    cpSync(srcFile, destFile);
    console.log(`→ 配置：${srcFile} → ${destFile}`);
  }

  materializeConfigFromTemplates(destDir);

  const destPi = join(destDir, 'pi-agent');
  let srcPi = null;
  for (const srcDir of sourceDirs) {
    if (!srcDir) continue;
    const candidate = join(srcDir, 'pi-agent');
    if (existsSync(candidate)) {
      srcPi = candidate;
      break;
    }
  }
  if (srcPi) {
    if (existsSync(destPi)) {
      if (overwrite) {
        cpSync(srcPi, destPi, { recursive: true, force: true });
        console.log(`→ 配置：覆盖 ${destPi} ← ${srcPi}`);
      } else {
        conflicts.push({ kind: 'config', name: 'pi-agent/', dest: destPi, src: srcPi });
        console.warn(`⚠️  配置冲突：pi-agent/ 目标已存在，已跳过（使用 --overwrite-config 覆盖）`);
      }
    } else {
      cpSync(srcPi, destPi, { recursive: true });
      console.log(`→ 配置：${srcPi} → ${destPi}`);
    }
  }

  return conflicts;
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

/**
 * @param {string} destDir
 * @param {string[]} sourceDirs
 * @param {{ overwriteRuntime?: boolean }} [opts]
 * @returns {Array<{ kind: 'runtime', rel: string, dest: string, src: string }>}
 */
export function mergeRuntimeInto(destDir, sourceDirs, opts = {}) {
  const overwrite = opts.overwriteRuntime === true;
  /** @type {Array<{ kind: 'runtime', rel: string, dest: string, src: string }>} */
  const conflicts = [];
  mkdirSync(destDir, { recursive: true });
  for (const src of sourceDirs) {
    if (!src || !existsSync(src)) continue;
    console.log(`→ 合并运行态：${src} → ${destDir}`);
    for (const rel of walkRelative(src)) {
      const destPath = join(destDir, rel);
      const srcPath = join(src, rel);
      if (existsSync(destPath)) {
        if (overwrite) {
          cpSync(srcPath, destPath, { force: true });
        } else {
          conflicts.push({ kind: 'runtime', rel, dest: destPath, src: srcPath });
        }
        continue;
      }
      mkdirSync(dirname(destPath), { recursive: true });
      cpSync(srcPath, destPath);
    }
  }
  if (conflicts.length > 0 && !overwrite) {
    const sample = conflicts.slice(0, 5).map((c) => c.rel).join(', ');
    const more = conflicts.length > 5 ? ` …共 ${conflicts.length} 处` : '';
    console.warn(`⚠️  运行态冲突：${sample}${more} 目标已存在，已跳过（使用 --overwrite-runtime 覆盖）`);
  }
  return conflicts;
}
