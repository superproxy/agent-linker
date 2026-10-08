/** 与网关 frps allowPorts 一致。 */
export const REMOTE_PORT_START = 10000;
export const REMOTE_PORT_END = 50000;

export interface NatTunnelSpec {
  serverAddr: string;
  serverPort: number;
  token: string;
  name: string;
  localHost: string;
  localPort: number;
  remotePort: number;
}

export function assertRemotePort(port: number): void {
  if (!Number.isInteger(port) || port < REMOTE_PORT_START || port > REMOTE_PORT_END) {
    throw new Error(`远端端口必须在 ${REMOTE_PORT_START}-${REMOTE_PORT_END}`);
  }
}

/** 生成连到网关 frps 的 frpc 配置。本机端口经 NAT 主动连出去。 */
export function renderFrpcConfig(spec: NatTunnelSpec): string {
  assertRemotePort(spec.remotePort);
  if (!Number.isInteger(spec.localPort) || spec.localPort < 1 || spec.localPort > 65535) {
    throw new Error('本地端口无效');
  }
  if (!spec.token) throw new Error('缺少 frps token');
  if (!/^[A-Za-z0-9._-]+$/.test(spec.name)) throw new Error('隧道名称无效');
  return `serverAddr = "${spec.serverAddr}"
serverPort = ${spec.serverPort}
auth.method = "token"
auth.token = "${spec.token}"

[[proxies]]
name = "${spec.name}"
type = "tcp"
localIP = "${spec.localHost}"
localPort = ${spec.localPort}
remotePort = ${spec.remotePort}
`;
}
