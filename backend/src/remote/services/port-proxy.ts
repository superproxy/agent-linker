import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RemoteAgent } from '../types.js';
import { loadSharedConfig } from '../../gateway/config.js';
import { createInstallLayout } from '../../install/layout.js';

const execAsync = promisify(exec);
const layout = createInstallLayout();
const { config } = loadSharedConfig(undefined, layout.state('gateway'));

/**
 * 端口代理服务
 * 支持把远程Agent的端口通过nginx反向代理或者frp内网穿透暴露
 */
export class PortProxyService {
  /** 代理类型 */
  public static async createProxy(
    agent: RemoteAgent,
    localPort: number,
    proxyType: 'nginx' | 'frp' = 'nginx',
    options?: { domain?: string; subdomain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    if (proxyType === 'nginx') {
      return this.createNginxProxy(agent, localPort, options);
    } else {
      return this.createFrpProxy(agent, localPort, options);
    }
  }

  /** 创建nginx反向代理 */
  private static async createNginxProxy(
    agent: RemoteAgent,
    localPort: number,
    options?: { domain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    const proxyId = `proxy-${agent.agentId}-${localPort}`;
    const target = `http://127.0.0.1:${localPort}`; // 这里应该是Agent的内网地址，实际环境替换为真实Agent地址
    const domain = options?.domain || `${proxyId}.dev.example.com`;

    // 动态添加nginx配置
    const nginxConfig = `
server {
  listen 80;
  server_name ${domain};
  location / {
    proxy_pass ${target};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
`;

    // 写入nginx配置并reload
    // 实际环境根据nginx配置路径调整
    // await writeFile(`/etc/nginx/conf.d/${proxyId}.conf`, nginxConfig);
    // await execAsync('nginx -s reload');

    return {
      proxyId,
      accessUrl: `http://${domain}`,
    };
  }

  /** 创建frp内网穿透代理 */
  private static async createFrpProxy(
    agent: RemoteAgent,
    localPort: number,
    options?: { subdomain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    const proxyId = `proxy-${agent.agentId}-${localPort}`;
    const subdomain = options?.subdomain || proxyId;

    // 生成frpc配置
    const frpcConfig = `
serverAddr = "${config.frps.serverAddr || '127.0.0.1'}"
serverPort = ${config.frps.bindPort || 7000}
${config.frps.token ? `auth.token = "${config.frps.token}"` : ''}

[[proxies]]
name = "${proxyId}"
type = "http"
localPort = ${localPort}
subdomain = "${subdomain}"
`;

    // 启动frpc进程
    // 实际环境会把配置下发到Agent端启动frpc
    // await agent.sendCommand('frpc:start', { config: frpcConfig });

    const frpsDomain = config.frps.domain || 'dev.example.com';
    return {
      proxyId,
      accessUrl: `http://${subdomain}.${frpsDomain}`,
    };
  }

  /** 停止代理 */
  public static async stopProxy(proxyId: string, proxyType: 'nginx' | 'frp') {
    if (proxyType === 'nginx') {
      // await unlink(`/etc/nginx/conf.d/${proxyId}.conf`);
      // await execAsync('nginx -s reload');
    } else {
      // 下发命令停止Agent端的frpc进程
    }
  }
}
