/**
 * core.channel.routing —— 消息 → (agentId, sessionKey) 路由
 *
 * 对齐 openclaw 的 sessionKey 格式（buildAgentPeerSessionKey）：
 * - DM（dmScope=per-account-channel-peer）: agent:<agentId>:<channel>:<accountId>:direct:<peerId>
 * - 群组（groupScope=per-group）:          agent:<agentId>:<channel>:<group>:<peerId>
 * - main 兜底:                             agent:<agentId>:main
 *
 * 与 openclaw 默认（dmScope=main，所有 DM 用户共享 main 会话）不同，
 * linkagent 默认 per-account-channel-peer，让每个微信用户拥有独立 agent 会话
 * （多轮记忆不串用户）。可通过渠道配置 session.dmScope 覆盖。
 *
 * 企微例外：会话键是 `wecom:<userid>` / `wecom:group:<chatId>`，不含 agentId。
 * agent 由任务绑定决定，身份只来自渠道用户或网关 token。
 */
import { normalizeAccountId, DEFAULT_ACCOUNT_ID } from './account-id.js';

export type RoutePeerKind = 'direct' | 'group';

export interface RoutePeer {
  kind: RoutePeerKind | string;
  id: string;
}

export interface ResolvedAgentRoute {
  agentId: string;
  channel: string;
  accountId: string;
  dmScope: string;
  groupScope: string;
  sessionKey: string;
  mainSessionKey: string;
  matchedBy: string;
}

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSessionPeerId(peerId: string): string {
  return peerId.trim().toLowerCase();
}

/** 插件 From 常为 `wecom:<userid>` 或 `wecom:group:<chatId>`，会话键只保留对端 id。 */
function stripChannelPeer(channel: string, raw: string): { kind: 'group' | 'direct'; id: string } | null {
  let id = raw.trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  const groupPrefix = `${channel}:group:`;
  const directPrefix = `${channel}:`;
  let kind: 'group' | 'direct' = 'direct';
  if (lower.startsWith(groupPrefix)) {
    kind = 'group';
    id = id.slice(groupPrefix.length);
  } else if (lower.startsWith(directPrefix)) {
    id = id.slice(directPrefix.length);
  }
  id = normalizeSessionPeerId(id);
  return id ? { kind, id } : null;
}

/** 对齐 openclaw buildAgentPeerSessionKey（只保留 linkagent 需要的分支） */
export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId: string;
  peerKind?: RoutePeerKind | string;
  peerId?: string | null;
  dmScope?: string;
  groupScope?: string;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const peerKind = params.peerKind ?? 'direct';
  const peerId = normalizeSessionPeerId(params.peerId ?? '') || null;
  if (peerKind === 'direct') {
    const dmScope = params.dmScope ?? 'per-account-channel-peer';
    if (dmScope === 'per-account-channel-peer' && peerId) {
      return `agent:${agentId}:${params.channel}:${normalizeAccountId(params.accountId)}:direct:${peerId}`;
    }
    if (dmScope === 'per-channel-peer' && peerId) {
      return `agent:${agentId}:${params.channel}:direct:${peerId}`;
    }
    if (dmScope === 'per-peer' && peerId) return `agent:${agentId}:direct:${peerId}`;
    return `agent:${agentId}:main`;
  }
  if (params.groupScope === 'main') return `agent:${agentId}:main`;
  return `agent:${agentId}:${params.channel}:${peerKind}:${peerId || 'unknown'}`;
}

/**
 * 解析路由。cfg 结构（openclaw 兼容）：
 *   { channels: { <channel>: { agentId?, session?: { dmScope?, groupScope? } } }, session?: { dmScope?, groupScope? } }
 * agentId 缺省用传入的 defaultAgentId；仍缺省则 'pi'。企微不返回 agentId。
 */
export function resolveAgentRoute(params: {
  cfg?: Record<string, unknown>;
  channel?: string;
  accountId?: string;
  peer?: RoutePeer | null;
  defaultAgentId?: string;
  dmScope?: string;
  groupScope?: string;
}): ResolvedAgentRoute {
  const channel = (params.channel ?? '').trim().toLowerCase() || 'unknown';
  const accountId = normalizeAccountId(params.accountId);
  const cfg = params.cfg as Record<string, unknown> | undefined;
  const channelsConfig = (cfg?.channels ?? {}) as Record<string, unknown>;
  const section = channelsConfig[channel] as
    | { agentId?: string; session?: { dmScope?: string; groupScope?: string } }
    | undefined;
  const dmScope = params.dmScope ?? section?.session?.dmScope ?? (cfg?.session as { dmScope?: string } | undefined)?.dmScope ?? 'per-account-channel-peer';
  const groupScope = params.groupScope ?? section?.session?.groupScope ?? (cfg?.session as { groupScope?: string } | undefined)?.groupScope ?? 'per-group';
  const peer = params.peer?.id ? { kind: params.peer.kind, id: params.peer.id } : null;
  if (channel === 'wecom') {
    const stripped = peer?.id ? stripChannelPeer(channel, peer.id) : null;
    const kind = peer?.kind === 'group' || stripped?.kind === 'group' ? 'group' : 'direct';
    const id = stripped?.id ?? '';
    const sessionKey = id ? (kind === 'group' ? `wecom:group:${id}` : `wecom:${id}`) : 'wecom:unknown';
    return {
      agentId: '',
      channel,
      accountId,
      dmScope,
      groupScope,
      sessionKey,
      mainSessionKey: 'wecom:main',
      // 非 default：插件动态路由不会把 agent:<id> 写回 sessionKey。
      matchedBy: id ? 'binding.peer' : 'channel-user',
    };
  }
  const agentId =
    normalizeAgentId(section?.agentId ?? '') ||
    normalizeAgentId(params.defaultAgentId ?? '') ||
    'pi';
  const sessionKey = buildAgentSessionKey({
    agentId,
    channel,
    accountId,
    peerKind: peer?.kind ?? 'direct',
    peerId: peer?.id ?? null,
    dmScope,
    groupScope,
  });
  const mainSessionKey = `agent:${agentId}:main`;
  return {
    agentId,
    channel,
    accountId,
    dmScope,
    groupScope,
    sessionKey,
    mainSessionKey,
    matchedBy: peer ? 'binding.peer' : 'default',
  };
}

export { DEFAULT_ACCOUNT_ID, normalizeAccountId };
