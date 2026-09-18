import type { ReactNode } from 'react';
import {
  AppstoreOutlined,
  ClusterOutlined,
  ControlOutlined,
  DashboardOutlined,
  KeyOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { processApiBase as processApiBaseImpl } from './local-base';

export { DEFAULT_BASE, isLoopbackBase, isLoopbackHostname, initialGatewayBase, alignToPageOrigin } from './local-base';

export const LS_KEY = 'linkagent.gw.base';
export const LS_TAB_KEY = 'linkagent.gw.tab';
export const LS_TOKEN_KEY = 'linkagent.gw.token';
export const LS_PROFILES_KEY = 'linkagent.gw.profiles';

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
  | 'agents'
  | 'tasks'
  | 'keys'
  | 'my-token'
  | 'channel-tokens'
  | 'nodes'
  | 'weixin'
  | 'accounts'
  | 'processes'
  | 'settings';

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

export const NAV_GROUPS: NavGroup[] = [
  {
    title: '监控',
    items: [{ id: 'overview', label: '概览 / 测试台', icon: <DashboardOutlined /> }],
  },
  {
    title: '运行时',
    items: [
      { id: 'agents', label: 'Agent 管理', icon: <AppstoreOutlined /> },
      { id: 'tasks', label: '任务', icon: <MessageOutlined /> },
      { id: 'nodes', label: '节点管理', icon: <ClusterOutlined /> },
    ],
  },
  {
    title: '凭据',
    items: [
      { id: 'keys', label: 'Key 管理', icon: <KeyOutlined /> },
      { id: 'my-token', label: '我的 Token', icon: <SafetyCertificateOutlined /> },
      { id: 'channel-tokens', label: '渠道凭据', icon: <SafetyCertificateOutlined />, adminOnly: true },
    ],
  },
  {
    title: '渠道',
    items: [{ id: 'weixin', label: '微信登录', icon: <MessageOutlined /> }],
  },
  {
    title: '系统',
    items: [
      { id: 'accounts', label: '真实用户', icon: <TeamOutlined />, adminOnly: true },
      { id: 'processes', label: '进程管理', icon: <ControlOutlined />, adminOnly: true },
      { id: 'settings', label: '网关设置', icon: <SettingOutlined />, adminOnly: true },
    ],
  },
];

export const ALL_TABS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

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
