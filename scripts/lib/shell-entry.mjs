import { existsSync } from 'node:fs';
import path from 'node:path';

/** 仓库 ops-/dev- 前缀脚本 vs dist 去前缀后的同名脚本 */
export function scriptSibling(dir, base, ext) {
  const prefixed = path.join(dir, `${base}.${ext}`);
  if (existsSync(prefixed)) return prefixed;
  const plain = path.join(dir, `${base.replace(/^(ops-|dev-)/, '')}.${ext}`);
  if (existsSync(plain)) return plain;
  return prefixed;
}

/** base 不含扩展名，如 edge-ctl → edge-ctl.sh（兼容 ops-edge-ctl.sh） */
export function shellScriptPath(dir, name) {
  const plain = path.join(dir, `${name}.sh`);
  if (existsSync(plain)) return plain;
  const ops = path.join(dir, `ops-${name}.sh`);
  if (existsSync(ops)) return ops;
  return plain;
}

/** dist 安装根下的 server-ctl.sh / edge-server-ctl.sh（不在 scripts/ 重复一份） */
export function installRootShellScriptPath(scriptsDir, name) {
  const atRoot = path.join(path.dirname(scriptsDir), `${name}.sh`);
  if (existsSync(atRoot)) return atRoot;
  return shellScriptPath(scriptsDir, name);
}

export function psScriptPath(dir, name) {
  const plain = path.join(dir, `${name}.ps1`);
  if (existsSync(plain)) return plain;
  const ops = path.join(dir, `ops-${name}.ps1`);
  if (existsSync(ops)) return ops;
  return plain;
}

export function devScriptPath(dir, fileName) {
  const dev = path.join(dir, `dev-${fileName}`);
  if (existsSync(dev)) return dev;
  return path.join(dir, fileName);
}
