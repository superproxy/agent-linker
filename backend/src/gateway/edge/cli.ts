/**
 * 边缘配置准备。只写文件并打印路径，不启动 frps / APISIX。
 * scripts/edge.sh 读取这些行后再拉起进程。
 *
 *   tsx src/gateway/edge/cli.ts
 */
import { getLayout } from '../../install/layout.js';
import { loadSharedConfig } from '../config.js';
import { dockerExecutable, prepareGatewayEdge, resolveComposeLauncher } from './runtime.js';

function pluginAddr(host: string, port: number): string {
  const pluginHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `${pluginHost}:${port}`;
}

async function main(): Promise<void> {
  const layout = getLayout();
  const { config } = loadSharedConfig(layout.configFile, layout.state('gateway'));
  const { host, port } = config.gateway.server;
  const prepared = await prepareGatewayEdge({
    toolsDir: layout.state('tools'),
    runtimeDir: layout.state('edge'),
    idePrefix: '/',
    ideUpstream: 'http://127.0.0.1:8000',
    gatewayUpstream: `http://127.0.0.1:${port}`,
    frpPluginAddr: pluginAddr(host, port),
  });
  const compose = resolveComposeLauncher(dockerExecutable());
  const lines = [
    `frpsBin=${prepared.frpsBin ?? ''}`,
    `frpsConf=${prepared.frpsConf}`,
    `composeFile=${prepared.composeFile}`,
    `composeProject=${prepared.composeProject}`,
    `composeBin=${compose?.command ?? ''}`,
    `composeStyle=${compose?.style ?? 'none'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

void main().catch((err) => {
  console.error(`[edge] 配置准备失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
