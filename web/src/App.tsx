import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spin } from 'antd';
import { ApiError, AuthClient, type UserPublic } from './api';
import {
  ALL_TABS,
  LS_KEY,
  LS_TAB_KEY,
  LS_TOKEN_KEY,
  initialGatewayBase,
  alignToPageOrigin,
  readToken,
  resolveStoredTab,
  resolveTabRoute,
  type TabId,
} from './lib/constants';
import { useRefreshTick } from './lib/hooks';
import { DashboardLayout } from './components/DashboardLayout';
import { LoginPage } from './pages/Login';
import { ChangePasswordModal } from './pages/ChangePasswordModal';
import { Overview } from './pages/Overview';
import { ChatPage } from './pages/Chat';
import type { ChatSession } from './pages/types';
import { AgentsPage } from './pages/Agents';
import { TasksPage } from './pages/Tasks';
import { KeysPage } from './pages/Keys';
import { MyTokenPage } from './pages/MyToken';
import { NodeKeyPage } from './pages/NodeKey';
import { NodesPage } from './pages/Nodes';
import { WeixinPage } from './pages/Weixin';
import { WecomPage } from './pages/Wecom';
import { FeishuPage } from './pages/Feishu';
import { AccountsPage } from './pages/Accounts';
import { LocalGatewayPage, RemoteGatewayPage } from './pages/Settings';
import { ProcessesPage } from './pages/Processes';

type AuthState =
  | { status: 'loading' }
  | { status: 'login'; error?: string; initialAdmin?: { username: string; password: string } }
  | { status: 'disabled' }
  | { status: 'token' }
  | { status: 'ready'; user: UserPublic };

const isTabAllowed = (tab: TabId, auth: AuthState): boolean => {
  const meta = ALL_TABS.find((t) => t.id === tab);
  if (!meta?.adminOnly) return true;
  if (auth.status === 'ready') return auth.user.role === 'admin';
  // token 模式（持管理员静态 token）允许管理员页；disabled 为本机免登录
  return auth.status === 'token' || auth.status === 'disabled';
};

export function App() {
  const [base, setBase] = useState(() =>
    initialGatewayBase(window.location.origin, localStorage.getItem(LS_KEY)),
  );
  const [, setTokenState] = useState(readToken);
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [tab, setTab] = useState<TabId>(() => resolveStoredTab(localStorage.getItem(LS_TAB_KEY)));
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const { bump } = useRefreshTick();

  const authClient = useMemo(() => new AuthClient(base), [base]);

  const bootstrap = useCallback(async () => {
    setAuth({ status: 'loading' });
    try {
      const me = await authClient.me(readToken());
      if (!me.authEnabled) setAuth({ status: 'disabled' });
      else if (me.local && me.user) setAuth({ status: 'ready', user: me.user });
      else if (me.user) setAuth({ status: 'ready', user: me.user });
      else if (me.tokenAuth) setAuth({ status: 'token' });
      else setAuth({ status: 'login', initialAdmin: me.initialAdmin });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth({ status: 'login' });
      else setAuth({ status: 'login', error: e instanceof Error ? e.message : String(e) });
    }
  }, [authClient]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const doLogin = async (username: string, password: string): Promise<string | null> => {
    try {
      const r = await authClient.login(username, password);
      localStorage.setItem(LS_TOKEN_KEY, r.token);
      setTokenState(r.token);
      setAuth({ status: 'ready', user: r.user });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const logout = useCallback(() => {
    void new AuthClient(base).logout(readToken()).catch(() => {});
    localStorage.removeItem(LS_TOKEN_KEY);
    setTokenState('');
    setAuth({ status: 'login' });
  }, [base]);

  const applyBase = (next: string) => {
    const url = alignToPageOrigin(window.location.origin, next.trim());
    localStorage.setItem(LS_KEY, url);
    window.location.reload();
  };

  // 401 统一登出
  const handleAuthError = useCallback(
    (e: unknown): boolean => {
      if (e instanceof ApiError && e.status === 401) {
        logout();
        return true;
      }
      return false;
    },
    [logout],
  );

  const goTab = (t: TabId) => {
    setTab(t);
    localStorage.setItem(LS_TAB_KEY, t);
  };

  if (auth.status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin tip="正在连接网关…" size="large">
          <div style={{ width: 200 }} />
        </Spin>
      </div>
    );
  }

  if (auth.status === 'login') {
    return (
      <LoginPage
        base={base}
        error={auth.error}
        initialAdmin={auth.initialAdmin}
        onApplyBase={applyBase}
        onLogin={doLogin}
      />
    );
  }

  const currentUser = auth.status === 'ready' ? auth.user : null;
  const token = readToken();
  const effectiveTab = isTabAllowed(tab, auth) ? tab : 'overview';

  return (
    <>
      <DashboardLayout
        active={effectiveTab}
        onTab={goTab}
        currentUser={currentUser}
        authMode={auth.status}
        base={base}
        token={token}
        onRefresh={bump}
        onLogout={logout}
        onChangePassword={() => setPwdOpen(true)}
      >
        <PageRouter
          tab={effectiveTab}
          base={base}
          token={token}
          auth={auth}
          onAuthError={handleAuthError}
          onApplyBase={applyBase}
          onGoTab={goTab}
          chatSession={chatSession}
          onOpenChat={(s) => {
            setChatSession(s);
            goTab('chat');
          }}
          onClearChatSession={() => setChatSession(null)}
        />
      </DashboardLayout>

      {currentUser?.mustChangePassword ? (
        <ChangePasswordModal
          open
          forced
          user={currentUser}
          onDone={(u) => setAuth({ status: 'ready', user: u })}
          onLogout={logout}
        />
      ) : null}
      {currentUser ? (
        <ChangePasswordModal
          open={pwdOpen}
          user={currentUser}
          onDone={(u) => setAuth({ status: 'ready', user: u })}
          onLogout={logout}
          onClose={() => setPwdOpen(false)}
        />
      ) : null}
    </>
  );
}

function PageRouter(props: {
  tab: TabId;
  base: string;
  token: string;
  auth: AuthState;
  onAuthError: (e: unknown) => boolean;
  onApplyBase: (next: string) => void;
  onGoTab: (t: TabId) => void;
  chatSession: ChatSession | null;
  onOpenChat: (s: ChatSession) => void;
  onClearChatSession: () => void;
}) {
  const { tab, base, token, onAuthError } = props;
  const routeTab = resolveTabRoute(tab);
  const isAdmin = props.auth.status === 'ready' ? props.auth.user.role === 'admin' : true;
  const username = props.auth.status === 'ready' ? props.auth.user.username : undefined;

  switch (routeTab) {
    case 'overview':
      return <Overview base={base} token={token} onAuthError={onAuthError} isAdmin={isAdmin} />;
    case 'chat':
      return (
        <ChatPage
          base={base}
          token={token}
          onAuthError={onAuthError}
          session={props.chatSession}
          onClearSession={props.onClearChatSession}
        />
      );
    case 'local-agents':
      return <AgentsPage scope="local" base={base} token={token} onAuthError={onAuthError} />;
    case 'remote-agents':
      return (
        <AgentsPage
          scope="remote"
          base={base}
          token={token}
          onAuthError={onAuthError}
          onGoNodes={() => props.onGoTab('remote-nodes')}
        />
      );
    case 'tasks':
      return <TasksPage base={base} token={token} onAuthError={onAuthError} onOpenChat={props.onOpenChat} username={username} isAdmin={isAdmin} />;
    case 'keys':
      return <KeysPage base={base} token={token} onAuthError={onAuthError} isAdmin={isAdmin} />;
    case 'my-token':
      if (props.auth.status === 'ready') {
        const u = props.auth.user;
        return (
          <MyTokenPage
            base={base}
            token={token}
            onAuthError={onAuthError}
            isAdmin={isAdmin}
            showPat={u.username !== 'local'}
          />
        );
      }
      if (props.auth.status === 'token') {
        return (
          <MyTokenPage
            base={base}
            token={token}
            onAuthError={onAuthError}
            isAdmin
            showPat={false}
          />
        );
      }
      return null;
    case 'node-key':
      return props.auth.status === 'ready' ? (
        <NodeKeyPage base={base} token={token} onAuthError={onAuthError} />
      ) : null;
    case 'local-nodes':
      return (
        <NodesPage scope="local" base={base} token={token} onAuthError={onAuthError} isAdmin={isAdmin} onGoTab={props.onGoTab} />
      );
    case 'remote-nodes':
      return (
        <NodesPage scope="remote" base={base} token={token} onAuthError={onAuthError} isAdmin={isAdmin} username={username} onGoTab={props.onGoTab} />
      );
    case 'weixin':
      return <WeixinPage base={base} token={token} onAuthError={onAuthError} username={username} isAdmin={isAdmin} />;
    case 'wecom':
      return <WecomPage token={token} onAuthError={onAuthError} isAdmin={isAdmin} />;
    case 'feishu':
      return <FeishuPage token={token} onAuthError={onAuthError} isAdmin={isAdmin} />;
    case 'accounts':
      return isAdmin ? <AccountsPage base={base} token={token} onAuthError={onAuthError} /> : null;
    case 'processes':
      return isAdmin ? <ProcessesPage token={token} /> : null;
    case 'local-gateway':
      return isAdmin ? (
        <LocalGatewayPage token={token} onAuthError={onAuthError} onApplyBase={props.onApplyBase} />
      ) : null;
    case 'remote-gateway':
      return isAdmin ? (
        <RemoteGatewayPage
          base={base}
          token={token}
          onAuthError={onAuthError}
          onApplyBase={props.onApplyBase}
        />
      ) : null;
    default:
      return null;
  }
}
