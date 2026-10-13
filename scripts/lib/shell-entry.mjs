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

/** base 不含扩展名，如 edge-ctl → ops-edge-ctl.sh / edge-ctl.sh / 旧 edge.sh */
export function shellScriptPath(dir, name) {
  const plain = path.join(dir, `${name}.sh`);
  if (existsSync(plain)) return plain;
  const ops = path.join(dir, `ops-${name}.sh`);
  if (existsSync(ops)) return ops;
  if (name === 'edge-ctl') {
    const legacy = path.join(dir, 'edge.sh');
    if (existsSync(legacy)) return legacy;
    const legacyOps = path.join(dir, 'ops-edge-ctl.sh');
    if (existsSync(legacyOps)) return legacyOps;
    const legacyOps2 = path.join(dir, 'ops-edge.sh');
    if (existsSync(legacyOps2)) return legacyOps2;
  }
  return plain;
}

export function psScriptPath(dir, name) {
  const plain = path.join(dir, `${name}.ps1`);
  if (existsSync(plain)) return plain;
  const ops = path.join(dir, `ops-${name}.ps1`);
  if (existsSync(ops)) return ops;
  if (name === 'edge-ctl') {
    const legacy = path.join(dir, 'edge.ps1');
    if (existsSync(legacy)) return legacy;
  }
  return plain;
}

export function devScriptPath(dir, fileName) {
  const dev = path.join(dir, `dev-${fileName}`);
  if (existsSync(dev)) return dev;
  return path.join(dir, fileName);
}
