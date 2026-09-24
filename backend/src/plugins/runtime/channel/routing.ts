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
 * agentId 缺省用传入的 defaultAgentId；仍缺省则 'pi'。
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
  const agentId =
    normalizeAgentId(section?.agentId ?? '') ||
    normalizeAgentId(params.defaultAgentId ?? '') ||
    'pi';
  const dmScope = params.dmScope ?? section?.session?.dmScope ?? (cfg?.session as { dmScope?: string } | undefined)?.dmScope ?? 'per-account-channel-peer';
  const groupScope = params.groupScope ?? section?.session?.groupScope ?? (cfg?.session as { groupScope?: string } | undefined)?.groupScope ?? 'per-group';
  const peer = params.peer?.id ? { kind: params.peer.kind, id: params.peer.id } : null;
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
