/** 节点 dotenv：-f / --env-file（与 backend/src/node/env-args.ts 语义一致） */
export function parseNodeEnvFileArgs(argv) {
  const envFiles = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--env-file') {
      const v = argv[i + 1];
      if (!v || String(v).startsWith('-')) {
        return { envFiles: [], rest: [], error: `${a} 需要配置文件路径` };
      }
      envFiles.push(v);
      i++;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-f=')) {
      const v = a.slice(3);
      if (!v) return { envFiles: [], rest: [], error: '-f= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--env-file=')) {
      const v = a.slice('--env-file='.length);
      if (!v) return { envFiles: [], rest: [], error: '--env-file= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    rest.push(a);
  }
  return { envFiles, rest };
}

/** 传给 bin/node.mjs 的 argv 片段 */
export function nodeEntryEnvFileArgv(envFiles) {
  const out = [];
  for (const p of envFiles) {
    out.push('-f', p);
  }
  return out;
}
