import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Drawer, Dropdown, Layout, Menu, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  BellOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { BRAND_CONSOLE, BRAND_HEADER_SUB, BRAND_NAME, BRAND_TAGLINE } from '../lib/brand';
import { ALL_TABS, LS_SIDER_COLLAPSED_KEY, NAV_GROUPS, navGroupTitle, type TabId } from '../lib/constants';
import { GatewayClient, OpsClient, type UserPublic } from '../api';

const { Sider, Header, Content } = Layout;

function SiderMenu(props: {
  active: TabId;
  canAdmin: boolean;
  showUserKey: boolean;
  collapsed: boolean;
  onSelect: (t: TabId) => void;
}) {
  const items: MenuProps['items'] = useMemo(() => {
    const groups = NAV_GROUPS.map((g) => ({
      key: g.title,
      type: 'group' as const,
      label: g.title,
      children: g.items
        .filter((it) => {
          if (it.id === 'my-token') return props.showUserKey;
          return !it.adminOnly || props.canAdmin;
        })
        .map((it) => ({ key: it.id, icon: it.icon, label: it.label })),
    })).filter((g) => (g.children?.length ?? 0) > 0);
    if (!props.collapsed) return groups;
    return groups.flatMap((g) => g.children ?? []);
  }, [props.canAdmin, props.showUserKey, props.collapsed]);

  return (
    <Menu
      className="sider-menu"
      mode="inline"
      theme="dark"
      selectedKeys={[props.active]}
      inlineCollapsed={props.collapsed}
      items={items}
      onClick={(info) => {
        if (ALL_TABS.some((t) => t.id === info.key)) props.onSelect(info.key as TabId);
      }}
      style={{ background: 'transparent', borderInlineEnd: 0 }}
    />
  );
}

export function DashboardLayout(props: {
  active: TabId;
  onTab: (t: TabId) => void;
  currentUser: UserPublic | null;
  authMode: 'disabled' | 'token' | 'ready';
  base: string;
  token: string;
  onRefresh: () => void;
  onLogout: () => void;
  onChangePassword: () => void;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(LS_SIDER_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setSiderCollapsed = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(LS_SIDER_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore quota / private mode */
    }
  };
  const siderWidth = collapsed ? 64 : 224;
  const isAdmin = props.currentUser?.role === 'admin';
  const canAdmin = props.authMode !== 'ready' || isAdmin;
  /** 账号登录、本机 local 用户、或持网关 token 的管理员均可见 */
  const showUserKey = props.authMode === 'ready' || props.authMode === 'token';
  const activeMeta = ALL_TABS.find((t) => t.id === props.active);
  const groupTitle = navGroupTitle(props.active);

  const [healthOk, setHealthOk] = useState(false);
  const [healthText, setHealthText] = useState('检测中…');
  const [pendingNodes, setPendingNodes] = useState(0);

  useEffect(() => {
    const gw = new GatewayClient(props.base);
    const ops = new OpsClient(props.base, () => props.token);
    let alive = true;
    const poll = async () => {
      try {
        const h = await gw.health();
        if (alive) {
          setHealthOk(true);
          setHealthText(`${h.agents.length} agent 在线`);
        }
      } catch {
        if (alive) {
          setHealthOk(false);
          setHealthText('网关不可达');
        }
      }
      if (props.token) {
        try {
          const nodes = await ops.listNodes();
          if (alive) setPendingNodes(nodes.filter((n) => n.status === 'pending').length);
        } catch {
          /* 无权限时忽略 */
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [props.base, props.token]);

  const userMenu: MenuProps['items'] = [
    ...(props.currentUser
      ? [
          {
            key: 'who',
            label: (
              <span style={{ color: 'rgba(229,233,240,0.55)' }}>
                {props.currentUser.displayName || props.currentUser.username}
                {props.currentUser.role === 'admin' ? ' · 管理员' : ''}
              </span>
            ),
            disabled: true,
          },
          { type: 'divider' as const },
          ...(props.currentUser.username === 'local'
            ? []
            : [
                { key: 'pwd', icon: <SafetyCertificateOutlined />, label: '修改密码' },
                { type: 'divider' as const },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
              ]),
        ]
      : [{ key: 'clear', icon: <LogoutOutlined />, label: '清除 API Key' }]),
  ];

  const onUserMenu: MenuProps['onClick'] = ({ key }) => {
    if (key === 'logout' || key === 'clear') props.onLogout();
    if (key === 'pwd') props.onChangePassword();
  };

  const selectTab = (t: TabId) => {
    props.onTab(t);
    setDrawerOpen(false);
  };

  return (
    <Layout className="app-layout">
      {/* 桌面侧栏（lg 以上常驻，CSS 控制显隐）；移动端用 Drawer */}
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setSiderCollapsed}
        trigger={null}
        width={224}
        collapsedWidth={64}
        theme="dark"
        className="app-sider desktop-sider"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 30,
        }}
      >
        <div className="brand">
          <div className="brand-logo">◆</div>
          <div className="brand-text">
            <div className="brand-name">{BRAND_NAME}</div>
            <div className="brand-sub">{BRAND_TAGLINE}</div>
          </div>
        </div>
        <SiderMenu
          active={props.active}
          canAdmin={canAdmin}
          showUserKey={showUserKey}
          collapsed={collapsed}
          onSelect={selectTab}
        />
        <div className="sider-foot">
          {BRAND_CONSOLE}
          <br />
          OpenAI 兼容 · 流式推理
        </div>
      </Sider>

      <Drawer
        placement="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={240}
        styles={{ body: { padding: 0, background: '#0d1017' }, header: { display: 'none' } }}
      >
        <div className="brand" style={{ borderBottom: '1px solid #1b212b' }}>
          <div className="brand-logo">◆</div>
          <div className="brand-name">{BRAND_NAME}</div>
        </div>
        <SiderMenu
          active={props.active}
          canAdmin={canAdmin}
          showUserKey={showUserKey}
          collapsed={false}
          onSelect={selectTab}
        />
      </Drawer>

      <Layout style={{ marginLeft: siderWidth, minHeight: '100vh' }} className="app-main">
        <Header className="app-header">
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setSiderCollapsed(!collapsed)}
            style={{ color: '#e5e9f0' }}
            className="sider-collapse-trigger"
          />
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setDrawerOpen(true)}
            style={{ display: 'none', color: '#e5e9f0' }}
            className="menu-trigger"
          />
          <div className="header-title">
            <h2>{groupTitle && activeMeta ? `${groupTitle} · ${activeMeta.label}` : (activeMeta?.label ?? '')}</h2>
            <span className="sub">{BRAND_HEADER_SUB}</span>
          </div>
          <span className="header-spacer" />

          <Tooltip title={healthOk ? '网关连接正常' : '网关不可达'}>
            <Badge
              status={healthOk ? 'success' : 'error'}
              text={<span className="sub-muted">{healthText}</span>}
            />
          </Tooltip>

          {pendingNodes > 0 ? (
            <Tooltip title="有待审批节点，前往远程 · 节点处理">
              <Badge count={pendingNodes} size="small">
                <BellOutlined
                  style={{ fontSize: 16, color: '#eab308', cursor: 'pointer' }}
                  onClick={() => selectTab('remote-nodes')}
                />
              </Badge>
            </Tooltip>
          ) : null}

          <Button icon={<ReloadOutlined />} onClick={props.onRefresh}>
            刷新
          </Button>

          <Dropdown menu={{ items: userMenu, onClick: onUserMenu }} placement="bottomRight">
            <Button type="text" style={{ color: '#e5e9f0', gap: 8 }} icon={<UserOutlined />}>
              {props.currentUser
                ? props.currentUser.displayName || props.currentUser.username
                : 'API Key 模式'}
            </Button>
          </Dropdown>
        </Header>

        <Content className="app-content">{props.children}</Content>
      </Layout>
    </Layout>
  );
}
