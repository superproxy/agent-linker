import type { AgentDefinition, SharedConfig } from '@linkagent/shared';
import type { GatewayRuntimeOverlay } from './overlay.js';
import type { GatewayRuntimeRepository } from './repository.js';

/**
 * 预留：SQLite 运行时配置（与 overlay 快照同语义，便于事务与查询）。
 *
 * 建议库文件：`<gatewayStateDir>/runtime.db`（与 overlay.json 同目录，便于迁移工具并列发现）。
 *
 * 初版 schema（实现时可整表存 JSON blob，再逐步拆表）：
 * - meta(key TEXT PRIMARY KEY, value TEXT) — schema_version
 * - agent_extra(id TEXT PRIMARY KEY, definition_json TEXT)
 * - agent_enabled(id TEXT PRIMARY KEY, enabled INTEGER)
 * - node_extra_agent(id TEXT PRIMARY KEY)
 * - tasks_singleton(id INTEGER PRIMARY KEY CHECK (id=1), default_agent_id TEXT)
 * - weixin_singleton(id INTEGER PRIMARY KEY CHECK (id=1), accounts_json, mode, enabled)
 * - child_gateway(section TEXT PRIMARY KEY, gateway_url, gateway_token)
 *
 * 迁移：读取 overlay.json → INSERT；或 ensureBootstrapped 与 JSON 实现共用 overlayFromYaml。
 */
export class SqliteGatewayRuntimeRepository implements GatewayRuntimeRepository {
  constructor(_gatewayStateDir: string) {
    void _gatewayStateDir;
  }

  private notReady(): never {
    throw new Error(
      'LINKAGENT_RUNTIME_STORE=sqlite 尚未实现；请使用 json-overlay（默认）或移除该环境变量',
    );
  }

  loadOverlay(): GatewayRuntimeOverlay | null {
    return this.notReady();
  }

  saveOverlay(_overlay: GatewayRuntimeOverlay): void {
    this.notReady();
  }

  ensureBootstrapped(_yamlConfig: SharedConfig): GatewayRuntimeOverlay {
    return this.notReady();
  }

  setAgentEnabled(_agentId: string, _enabled: boolean, _defs: AgentDefinition[], _yamlAgentIds: string[]): void {
    this.notReady();
  }

  registerNodeAgent(_agentId: string): void {
    this.notReady();
  }

  setDefaultTaskAgentId(_agentId: string): void {
    this.notReady();
  }

  ensureWeixinAccount(_accountId: string): void {
    this.notReady();
  }

  removeWeixinAccount(_accountId: string): void {
    this.notReady();
  }

  setChildGateway(_section: 'weixin' | 'node', _url: string, _token: string): void {
    this.notReady();
  }

  setWeixinMode(_mode: import('@linkagent/shared').WeixinMode): void {
    this.notReady();
  }
}
