/** 从 argv 解析节点 dotenv 路径（-f / --env-file），供 connector 与运维脚本共用语义。 */
export function parseNodeEnvFileArgs(argv: readonly string[]): {
  envFiles: string[];
  rest: string[];
  error?: string;
} {
  const envFiles: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '-f' || a === '--env-file') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) {
        return { envFiles: [], rest: [], error: `${a} 需要配置文件路径` };
      }
      envFiles.push(v);
      i++;
      continue;
    }
    if (a.startsWith('-f=')) {
      const v = a.slice(3);
      if (!v) return { envFiles: [], rest: [], error: '-f= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    if (a.startsWith('--env-file=')) {
      const v = a.slice('--env-file='.length);
      if (!v) return { envFiles: [], rest: [], error: '--env-file= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    rest.push(a);
  }
  return { envFiles, rest };
}
