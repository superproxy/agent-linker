export { findInstallRoot, findRepoRoot } from '../install/layout.js';

export { loadSharedConfig, type LoadedSharedConfig } from './load.js';
export { parseSharedYamlFile, yamlBaseFromPath } from './yaml.js';

export {
  generateGatewayToken,
  ensureGatewayTokenFile,
  readGatewayTokenFile,
  resolveGatewayAuth,
  type ResolvedGatewayAuth,
} from './auth-token.js';

export {
  loopbackHost,
  deriveGatewayBase,
  sameGatewayOrigin,
  resolveChildRuntime,
  type ChildProcessRuntime,
} from './child-runtime.js';

export {
  loadGatewayConfig,
  gatewaySectionToLegacy,
  defaultConfig,
  type LoadedConfig,
} from './legacy.js';

export {
  persistDefaultTaskAgentId,
  persistAgentEnabled,
  persistNodeAgentRegistered,
  persistEnsureWeixinAccount,
  persistEnsureWeixinChannelGateway,
  persistRemoveWeixinAccount,
  persistChildGatewayTarget,
  type ChildSectionId,
  type ChildGatewayTarget,
} from './persist.js';

export {
  persistWecomChannelSetup,
  readWecomConfigView,
  maskSecret,
  DEFAULT_WECOM_PLUGIN,
  type WecomChannelPersistInput,
  type ChannelGatewayWecomPersistInput,
} from './persist-wecom.js';
