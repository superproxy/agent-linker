import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const feishuDist = join(
  root,
  '../node_modules/.pnpm/@openclaw+feishu@2026.9.6_openclaw@openclaw-shim/node_modules/@openclaw/feishu/dist',
);
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const existing = new Set(
  Object.keys(pkg.exports)
    .filter((k) => k.startsWith('./plugin-sdk/'))
    .map((k) => k.slice('./plugin-sdk/'.length)),
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name.name)) out.push(p);
  }
  return out;
}

const imports = new Map();
const re = /import\s*\{([^}]+)\}\s*from\s*["']openclaw\/plugin-sdk\/([^"']+)["']/g;
for (const file of walk(feishuDist)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(re)) {
    const spec = m[2];
    const names = m[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const bits = part.split(/\s+as\s+/);
        return (bits[1] ?? bits[0]).trim();
      })
      .filter((n) => n && n !== 'type');
    const set = imports.get(spec) ?? new Set();
    for (const n of names) set.add(n);
    imports.set(spec, set);
  }
}

function stubExport(name) {
  if (name === 'DEFAULT_ACCOUNT_ID') return `export const DEFAULT_ACCOUNT_ID = 'default';`;
  if (name === 'PAIRING_APPROVED_MESSAGE') return `export const PAIRING_APPROVED_MESSAGE = 'approved';`;
  if (name === 'createConditionalWarningCollector') {
    return `export const createConditionalWarningCollector = { findings: () => () => [] };`;
  }
  if (name.endsWith('Error')) {
    return `export class ${name} extends Error { constructor(message, options) { super(message, options); this.name = '${name}'; } }`;
  }
  return `export function ${name}(...args) {
  const head = args[0];
  if (head && typeof head === 'object' && !Array.isArray(head)) return { ...head };
  return undefined;
}`;
}

const sdkDir = join(root, 'src/sdk');
for (const [spec, names] of imports) {
  if (existing.has(spec)) continue;
  const file = join(sdkDir, `${spec}.mjs`);
  const body = [...names].sort().map(stubExport).join('\n\n');
  writeFileSync(file, `${body}\n`);
  pkg.exports[`./plugin-sdk/${spec}`] = `./src/sdk/${spec}.mjs`;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`specs=${imports.size} generated=${imports.size - [...imports.keys()].filter((s) => existing.has(s)).length}`);
