import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FrpcSection } from '@linkagent/shared';
import { createInstallLayout } from '../../install/layout.js';

const layout = createInstallLayout();

/** 生成frpc toml配置文件 */
export function generateFrpcConfig(config: FrpcSection): void {
  const configPath = join(layout.root, config.configPath);
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let configContent = `
serverAddr = "${config.serverAddr}"
serverPort = ${config.serverPort}
`;

  if (config.token) {
    configContent += `auth.token = "${config.token}"\n`;
  }

  // 添加代理规则
  for (const proxy of config.proxies) {
    configContent += `
[[proxies]]
name = "${proxy.name}"
type = "${proxy.type}"
localPort = ${proxy.localPort}
remotePort = ${proxy.remotePort}
`;
    if (proxy.customDomains && proxy.customDomains.length > 0) {
      configContent += `customDomains = [${proxy.customDomains.map(d => `"${d}"`).join(', ')}]\n`;
    }
  }

  writeFileSync(configPath, configContent, 'utf8');
}
