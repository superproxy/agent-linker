import type { SharedConfig } from '@linkagent/shared';
import { applyRuntimeOverlay } from './overlay.js';
import type { GatewayRuntimeRepository } from './repository.js';
import { JsonOverlayGatewayRuntimeRepository } from './json-overlay-repository.js';
import { SqliteGatewayRuntimeRepository } from './sqlite-repository.js';

/** 运行时配置持久化后端（环境变量 LINKAGENT_RUNTIME_STORE） */
export type GatewayRuntimeBackend = 'json-overlay' | 'sqlite';

const ENV_KEY = 'LINKAGENT_RUNTIME_STORE';

export function resolveGatewayRuntimeBackend(): GatewayRuntimeBackend {
  const raw = process.env[ENV_KEY]?.trim().toLowerCase();
  if (raw === 'sqlite') return 'sqlite';
  if (raw === 'json' || raw === 'json-overlay' || raw === 'overlay') return 'json-overlay';
  if (raw && raw !== 'json-overlay') {
    throw new Error(`未知 ${ENV_KEY}=${raw}，可选：json-overlay | sqlite`);
  }
  return 'json-overlay';
}

export function createGatewayRuntimeRepository(gatewayStateDir: string): GatewayRuntimeRepository {
  const backend = resolveGatewayRuntimeBackend();
  if (backend === 'sqlite') {
    return new SqliteGatewayRuntimeRepository(gatewayStateDir);
  }
  return new JsonOverlayGatewayRuntimeRepository(gatewayStateDir);
}

/** @deprecated 旧工厂名 */
export function createRuntimeConfigStore(gatewayStateDir: string): GatewayRuntimeRepository {
  return createGatewayRuntimeRepository(gatewayStateDir);
}

export function loadEffectiveSharedConfig(yamlConfig: SharedConfig, gatewayStateDir: string): SharedConfig {
  const repo = createGatewayRuntimeRepository(gatewayStateDir);
  const overlay = repo.ensureBootstrapped(yamlConfig);
  return applyRuntimeOverlay(yamlConfig, overlay);
}
