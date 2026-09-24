export type { GatewayRuntimeOverlay } from './overlay.js';
export { applyRuntimeOverlay, emptyRuntimeOverlay } from './overlay.js';
export type { GatewayRuntimeRepository, RuntimeConfigStore } from './repository.js';
export {
  createGatewayRuntimeRepository,
  createRuntimeConfigStore,
  loadEffectiveSharedConfig,
  resolveGatewayRuntimeBackend,
  type GatewayRuntimeBackend,
} from './factory.js';
export { RUNTIME_OVERLAY_FILENAME } from './json-overlay-repository.js';
