import { defaultConfig, gatewayConfigSchema, type GatewayConfig, type SharedConfig } from '@linkagent/shared';
import { loadSharedConfig, type LoadedSharedConfig } from './load.js';

export interface LoadedConfig {
  config: GatewayConfig;
  source: LoadedSharedConfig['source'];
  path: string;
}

/**
 * @deprecated 三进程共享配置请用 {@link loadSharedConfig}。
 * 保留旧签名：返回迁移后还原的扁平形状，供既有测试/调用方过渡。
 */
export function loadGatewayConfig(pathArg?: string, runtimeGatewayDir?: string): LoadedConfig {
  const shared = loadSharedConfig(pathArg, runtimeGatewayDir);
  const flat = gatewaySectionToLegacy(shared.config);
  return { config: flat, source: shared.source, path: shared.path };
}

/** 三段式 → 旧扁平形状（gatewayConfigSchema 的等价产物） */
export function gatewaySectionToLegacy(cfg: SharedConfig): GatewayConfig {
  return gatewayConfigSchema.parse({
    gateway: {
      server: cfg.gateway.server,
      auth: {
        mode: cfg.gateway.auth.mode,
        token: cfg.gateway.auth.token,
        sessionTtlDays: cfg.gateway.auth.sessionTtlDays,
      },
      agents: cfg.gateway.agents,
      defaultCwd: cfg.gateway.defaultCwd,
      channels: cfg.gateway.channels,
      plugins: cfg.gateway.plugins,
      tasks: cfg.gateway.tasks,
    },
    weixin: {
      mode: cfg.weixin.mode,
      ...(cfg.weixin.accountId ? { accountId: cfg.weixin.accountId } : {}),
      ...(cfg.weixin.model ? { model: cfg.weixin.model } : {}),
    },
  }) as GatewayConfig;
}

export { defaultConfig };
