import type { ReactNode } from 'react';
import {
  AppstoreOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  ControlOutlined,
  DashboardOutlined,
  DesktopOutlined,
  KeyOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { processApiBase as processApiBaseImpl } from './local-base';

export { DEFAULT_BASE, isLoopbackBase, isLoopbackHostname, initialGatewayBase, alignToPageOrigin } from './local-base';

export const LS_KEY = 'linkagent.gw.base';
export const LS_TAB_KEY = 'linkagent.gw.tab';
export const LS_TOKEN_KEY = 'linkagent.gw.token';
export const LS_PROFILES_KEY = 'linkagent.gw.profiles';
export const LS_SIDER_COLLAPSED_KEY = 'linkagent.gw.siderCollapsed';

/** 远程网关连接配置（仅保存在当前浏览器 localStorage） */
export interface GatewayProfile {
  id: string;
  name: string;
  url: string;
  /** 可选：网关开启鉴权时使用的永久凭据（gateway token / API token） */
  token?: string;
}

export type TabId =
  | 'overview'
  | 'chat'
  | 'local-agents'
  | 'remote-agents'
  | 'tasks'
  | 'keys'
  | 'my-token'
  | 'channel-tokens'
  | 'local-nodes'
  | 'remote-nodes'
  | 'node-key'
  | 'weixin'
  | 'accounts'
  | 'processes'
  | 'local-gateway'
  | 'remote-gateway';

export interface NavItem {
  id: TabId;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * 侧栏信息架构（自上而下）：
 * - 首页：总览
 * - 我的：登录用户日常 — 任务 → 三类 Key（k_/pat_/nt_）→ 微信 → 对话
 * - 本机 / 远程：管理员或运维的机器、网关、agent
 * - 系统：用户管理（登录账号）
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: '首页',
    items: [{ id: 'overview', label: '概览', icon: <DashboardOutlined /> }],
  },
  {
    title: '我的',
    items: [
      { id: 'tasks', label: '任务管理', icon: <AppstoreOutlined /> },
      { id: 'keys', label: '任务 Key', icon: <KeyOutlined /> },
      { id: 'my-token', label: '用户 Key', icon: <SafetyCertificateOutlined /> },
      { id: 'node-key', label: '节点 Key', icon: <ClusterOutlined /> },
      { id: 'weixin', label: '微信', icon: <MessageOutlined /> },
      { id: 'chat', label: '对话', icon: <MessageOutlined /> },
    ],
  },
  {
    title: '本机',
    items: [
      { id: 'local-gateway', label: '网关', icon: <DesktopOutlined />, adminOnly: true },
      { id: 'processes', label: '进程', icon: <ControlOutlined />, adminOnly: true },
      { id: 'local-nodes', label: '节点', icon: <ClusterOutlined />, adminOnly: true },
      { id: 'local-agents', label: 'agent', icon: <AppstoreOutlined />, adminOnly: true },
    ],
  },
  {
    title: '远程',
    items: [
      { id: 'remote-gateway', label: '网关', icon: <CloudServerOutlined />, adminOnly: true },
      { id: 'remote-nodes', label: '节点', icon: <ClusterOutlined /> },
      { id: 'remote-agents', label: 'agent', icon: <AppstoreOutlined /> },
    ],
  },
  {
    title: '系统',
    items: [{ id: 'accounts', label: '用户管理', icon: <TeamOutlined />, adminOnly: true }],
  },
];

export const ALL_TABS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 旧侧栏 tab id → 新 id（localStorage 兼容） */
const LEGACY_TABS: Record<string, TabId> = {
  agents: 'local-agents',
  nodes: 'remote-nodes',
  settings: 'local-gateway',
  'channel-tokens': 'my-token',
};

/** 侧栏 tab → 实际渲染页（保留扩展点） */
export function resolveTabRoute(tab: TabId): TabId {
  return tab;
}

export function resolveStoredTab(raw: string | null): TabId {
  if (!raw) return 'overview';
  const mapped = LEGACY_TABS[raw] ?? raw;
  return ALL_TABS.some((x) => x.id === mapped) ? (mapped as TabId) : 'overview';
}

export function navGroupTitle(tab: TabId): string | undefined {
  return NAV_GROUPS.find((g) => g.items.some((it) => it.id === tab))?.title;
}

export const readToken = (): string => localStorage.getItem(LS_TOKEN_KEY) ?? '';

/** 读取已保存的远程网关清单（数据损坏时回退空数组） */
export function readProfiles(): GatewayProfile[] {
  const raw = localStorage.getItem(LS_PROFILES_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is GatewayProfile =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as GatewayProfile).id === 'string' &&
        typeof (p as GatewayProfile).name === 'string' &&
        typeof (p as GatewayProfile).url === 'string',
    );
  } catch {
    return [];
  }
}

/** 持久化远程网关清单 */
export function writeProfiles(profiles: GatewayProfile[]): void {
  localStorage.setItem(LS_PROFILES_KEY, JSON.stringify(profiles));
}

/** 生成新 profile id */
export function newProfileId(): string {
  return `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 进程管理打当前打开的后台地址（与「网关连接」无关） */
export function processApiBase(): string {
  return processApiBaseImpl(window.location.origin);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function relTime(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
