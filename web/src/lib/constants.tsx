import type { ReactNode } from 'react';
import {
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  KeyOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';

export const DEFAULT_BASE = 'http://127.0.0.1:8787';
export const LS_KEY = 'linkagent.gw.base';
export const LS_TAB_KEY = 'linkagent.gw.tab';
export const LS_TOKEN_KEY = 'linkagent.gw.token';

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
      { id: 'settings', label: '网关设置', icon: <SettingOutlined />, adminOnly: true },
    ],
  },
];

export const ALL_TABS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export const readToken = (): string => localStorage.getItem(LS_TOKEN_KEY) ?? '';

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
