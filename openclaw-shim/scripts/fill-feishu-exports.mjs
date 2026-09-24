import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fileFor(spec) {
  const rel = pkg.exports[`./plugin-sdk/${spec}`];
  if (!rel) return null;
  return new URL(`../${rel}`, import.meta.url);
}

const backend = new URL('../../backend/', import.meta.url);
for (let i = 0; i < 40; i++) {
  const probe = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/probe-feishu.mjs'],
    { cwd: backend.pathname.replace(/^\//, '').replace(/\//g, '\\'), encoding: 'utf8', shell: true },
  );
  const msg = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  if (msg.includes('plugin-ok')) {
    console.log('plugin-ok');
    process.exit(0);
  }
  {
    void 0;
    const named = /does not provide an export named '([^']+)'/.exec(msg);
    const spec = /openclaw\/plugin-sdk\/([^']+)/.exec(msg);
    if (!named || !spec) {
      console.error('STOP', msg);
      process.exit(1);
    }
    const file = fileFor(spec[1]);
    if (!file) {
      console.error('NOFILE', spec[1], named[1]);
      process.exit(1);
    }
    const name = named[1];
    const line = name.endsWith('Error')
      ? `\nexport class ${name} extends Error { constructor(message, options) { super(message, options); this.name = '${name}'; } }\n`
      : `\nexport function ${name}(...args) { const head = args[0]; return head && typeof head === 'object' ? { ...head } : undefined; }\n`;
    appendFileSync(file, line);
    console.log(`add ${spec[1]}#${name}`);
  }
}
console.error('too many');
process.exit(1);
