import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config/default.yaml' assert { type: 'yaml' };

const execAsync = promisify(exec);
const writeFileAsync = promisify(writeFile);
const unlinkAsync = promisify(unlink);

/**
 * 端口代理服务
 * 支持把远程端口通过nginx反向代理或者frp内网穿透暴露到公网
 */
export class PortProxyService {
  /** 代理类型 */
  public static async createProxy(
    agentId: string,
    localPort: number,
    proxyType: 'nginx' | 'frp' = 'nginx',
    options?: { domain?: string; subdomain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    if (proxyType === 'nginx' && config.nginx.enabled) {
      return this.createNginxProxy(agentId, localPort, options);
    } else if (proxyType === 'frp' && config.frp.enabled) {
      return this.createFrpProxy(agentId, localPort, options);
    }
    throw new Error(`Proxy type ${proxyType} is not enabled`);
  }

  /** 创建nginx反向代理 */
  private static async createNginxProxy(
    agentId: string,
    localPort: number,
    options?: { domain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    const proxyId = `proxy-${agentId}-${localPort}`;
    const target = `http://127.0.0.1:${localPort}`; // 实际环境替换为远程Agent的地址
    const domain = options?.domain || `${proxyId}.${config.nginx.domainSuffix}`;

    // 生成nginx配置
    const nginxConfig = `
server {
  listen 80;
  server_name ${domain};
  
  # 支持websocket
  location / {
    proxy_pass ${target};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
  }
}
`;

    // 写入配置文件
    const configPath = join(config.nginx.configDir, `${proxyId}.conf`);
    if (!existsSync(config.nginx.configDir)) {
      mkdirSync(config.nginx.configDir, { recursive: true });
    }
    await writeFileAsync(configPath, nginxConfig, 'utf8');

    // 重载nginx
    try {
      await execAsync(config.nginx.reloadCommand);
    } catch (err) {
      await unlinkAsync(configPath).catch(() => {});
      throw new Error(`Nginx reload failed: ${(err as Error).message}`);
    }

    return {
      proxyId,
      accessUrl: `http://${domain}`,
    };
  }

  /** 创建frp内网穿透代理 */
  private static async createFrpProxy(
    agentId: string,
    localPort: number,
    options?: { subdomain?: string }
  ): Promise<{ accessUrl: string; proxyId: string }> {
    const proxyId = `proxy-${agentId}-${localPort}`;
    const subdomain = options?.subdomain || proxyId;

    // 生成frpc配置，实际使用时会下发到远程Agent端启动
    const frpcConfig = `
serverAddr = "${config.frp.serverAddr}"
serverPort = ${config.frp.serverPort}
${config.frp.token ? `auth.token = "${config.frp.token}"` : ''}

[[proxies]]
name = "${proxyId}"
type = "tcp"
localPort = ${localPort}
remotePort = ${10000 + Math.floor(Math.random() * 50000)} # 随机远程端口，实际可自定义
`;

    // 实际环境会把配置下发到Agent启动frpc，这里直接返回示例地址
    const accessUrl = options?.subdomain 
      ? `http://${subdomain}.${config.frp.domainSuffix}`
      : `http://${config.frp.serverAddr}:${10000 + Math.floor(Math.random() * 50000)}`;

    return {
      proxyId,
      accessUrl,
    };
  }

  /** 停止代理 */
  public static async stopProxy(proxyId: string, proxyType: 'nginx' | 'frp') {
    if (proxyType === 'nginx' && config.nginx.enabled) {
      const configPath = join(config.nginx.configDir, `${proxyId}.conf`);
      if (existsSync(configPath)) {
        await unlinkAsync(configPath);
        await execAsync(config.nginx.reloadCommand);
      }
    } else if (proxyType === 'frp' && config.frp.enabled) {
      // 实际环境会下发命令到Agent停止frpc进程
    }
  }
}
