/** 节点接入 env 片段：写入 dotenv 文件，或在 bash / PowerShell 当前会话导出 */

export type NodeEnvFlavor = 'dotenv' | 'bash' | 'powershell';

export interface NodeEnvFields {
  gatewayUrl: string;
  token?: string;
  /** 匿名申请时的 nu_ 归属申明码 */
  claimToken?: string;
  agents: string;
}

export const NODE_ENV_FLAVOR_OPTIONS: Array<{ value: NodeEnvFlavor; label: string }> = [
  { value: 'dotenv', label: 'env 文件' },
  { value: 'bash', label: 'Bash' },
  { value: 'powershell', label: 'PowerShell' },
];

function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pairs(fields: NodeEnvFields): Array<[string, string]> {
  const rows: Array<[string, string]> = [['LINKAGENT_GATEWAY_URL', fields.gatewayUrl]];
  if (fields.token) rows.push(['LINKAGENT_GATEWAY_TOKEN', fields.token]);
  if (fields.claimToken) rows.push(['LINKAGENT_NODE_CLAIM', fields.claimToken]);
  rows.push(['LINKAGENT_NODE_AGENTS', fields.agents]);
  return rows;
}

/** 生成可复制的节点环境变量片段 */
export function formatNodeEnv(fields: NodeEnvFields, flavor: NodeEnvFlavor): string {
  const rows = pairs(fields);
  if (flavor === 'bash') {
    return rows.map(([k, v]) => `export ${k}=${bashQuote(v)}`).join('\n');
  }
  if (flavor === 'powershell') {
    return rows.map(([k, v]) => `$env:${k}=${pwshQuote(v)}`).join('\n');
  }
  return rows.map(([k, v]) => `${k}=${v}`).join('\n');
}
