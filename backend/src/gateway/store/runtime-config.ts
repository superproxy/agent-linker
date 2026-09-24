/** @deprecated 请从 `./runtime/index.js` 导入；本文件保留兼容 re-export */
export type { GatewayRuntimeOverlay, GatewayRuntimeRepository, RuntimeConfigStore, GatewayRuntimeBackend } from './runtime/index.js';
export {
  applyRuntimeOverlay,
  createGatewayRuntimeRepository,
  createRuntimeConfigStore,
  loadEffectiveSharedConfig,
  resolveGatewayRuntimeBackend,
  RUNTIME_OVERLAY_FILENAME,
} from './runtime/index.js';
