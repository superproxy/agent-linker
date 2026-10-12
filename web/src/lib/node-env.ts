/** 节点接入 env 片段：写入 dotenv 文件，或在 bash / PowerShell 当前会话导出 */

export type NodeEnvFlavor = 'dotenv' | 'bash' | 'powershell';

export type NodePmAction = 'start' | 'restart' | 'dev';

export interface NodeEnvFields {
  gatewayUrl: string;
  token?: string;
  /** 匿名申请时的 nu_ 归属申明码 */
  claimToken?: string;
  agents: string;
  /** 控制台展示名（LINKAGENT_NODE_NAME） */
  nodeName?: string;
  /** 已注册节点 id，重连时可选显式指定 */
  nodeId?: string;
  /** 状态目录（多实例隔离；pnpm 命名实例通常由脚本自动设置） */
  stateDir?: string;
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
  if (fields.nodeName?.trim()) rows.push(['LINKAGENT_NODE_NAME', fields.nodeName.trim()]);
  if (fields.nodeId?.trim()) rows.push(['LINKAGENT_NODE_ID', fields.nodeId.trim()]);
  if (fields.stateDir?.trim()) rows.push(['LINKAGENT_NODE_STATE_DIR', fields.stateDir.trim()]);
  rows.push(['LINKAGENT_NODE_AGENTS', fields.agents]);
  return rows;
}

/** 命名实例对应的 .runtime-state env 文件路径 */
export function nodeEnvFilePath(instanceName?: string): string {
  const inst = instanceName?.trim();
  return inst ? `.runtime-state/node-${inst}.env` : '.runtime-state/node.env';
}

/** pnpm node:* 命令行（与 scripts/node-ctl.mjs 一致） */
export function formatNodePmCommand(action: NodePmAction, instanceName?: string): string {
  const script = action === 'dev' ? 'node:dev' : action === 'restart' ? 'node:restart' : 'node:start';
  const inst = instanceName?.trim();
  return inst ? `pnpm ${script} ${inst}` : `pnpm ${script}`;
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

/**
 * 环境变量 + 启动/重启命令（一键复制，便于节点机重启）。
 * dotenv  flavor 时在 env 块后附注释说明写入路径与 pm 命令。
 */
export function formatNodeLaunchSnippet(
  fields: NodeEnvFields,
  flavor: NodeEnvFlavor,
  action: NodePmAction = 'start',
  instanceName?: string,
): string {
  const env = formatNodeEnv(fields, flavor);
  const cmd = formatNodePmCommand(action, instanceName);
  if (flavor === 'dotenv') {
    const path = nodeEnvFilePath(instanceName);
    return `${env}\n\n# 写入 ${path} 后执行：\n${cmd}`;
  }
  return `${env}\n${cmd}`;
}

/** 从已注册节点信息推测 pnpm 实例名（与接入时 node:start <name> 一致） */
export function suggestNodeInstanceName(node: { name: string; nodeId: string }): string {
  const fromName = node.name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (fromName && fromName.length <= 48) return fromName;
  return node.nodeId.length > 8 ? node.nodeId.slice(-12) : node.nodeId;
}
