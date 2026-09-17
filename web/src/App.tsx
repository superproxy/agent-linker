import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdminClient,
  ApiError,
  AuthClient,
  GatewayClient,
  OpsClient,
  PmClient,
  UserAdminClient,
  WeixinClient,
  type AgentCatalogItem,
  type AgentDetail,
  type AgentInfo,
  type ChannelUserSummary,
  type ChannelTokenInfo,
  type ChatDelta,
  type ModelInfo,
  type NodeEnrollInfo,
  type NodeInfo,
  type PmProcess,
  type SystemInfo,
  type TaskItem,
  type UserPublic,
  type UserTasks,
  type WeixinStatus,
} from './api';

const DEFAULT_BASE = 'http://127.0.0.1:8787';
const LS_KEY = 'linkagent.gw.base';
const LS_TAB_KEY = 'linkagent.gw.tab';
const LS_TOKEN_KEY = 'linkagent.gw.token';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  error?: string;
  done?: boolean;
}

type TabId = 'overview' | 'agents' | 'tasks' | 'keys' | 'channel-tokens' | 'nodes' | 'weixin' | 'accounts' | 'settings';

const NAV: { id: TabId; label: string; adminOnly?: boolean }[] = [
  { id: 'overview', label: '概览 / 测试台' },
  { id: 'agents', label: 'Agent 管理' },
  { id: 'tasks', label: '任务管理' },
  { id: 'keys', label: 'Key 管理' },
  { id: 'channel-tokens', label: '用户凭据', adminOnly: true },
  { id: 'nodes', label: '节点管理' },
  { id: 'weixin', label: '微信登录' },
  { id: 'accounts', label: '登录账号', adminOnly: true },
  { id: 'settings', label: '网关设置' },
];

/** 401 统一登出；其余错误转文案 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function relTime(ts: number): string {
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

let msgSeq = 0;

type AuthState =
  | { status: 'loading' }
  | { status: 'login'; error?: string }
  | { status: 'disabled' }
  | { status: 'token' }
  | { status: 'ready'; user: UserPublic };

const readToken = () => localStorage.getItem(LS_TOKEN_KEY) ?? '';

export function App() {
  const [base, setBase] = useState(() => localStorage.getItem(LS_KEY) ?? DEFAULT_BASE);
  const [, setToken] = useState(readToken);
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  const [client] = useState(() => new GatewayClient(base, readToken));
  const [wxClient] = useState(() => new WeixinClient(base, readToken));
  const [authClient] = useState(() => new AuthClient(base));

  const bootstrap = useCallback(async () => {
    setAuth({ status: 'loading' });
    try {
      const me = await authClient.me(readToken());
      if (!me.authEnabled) setAuth({ status: 'disabled' });
      else if (me.user) setAuth({ status: 'ready', user: me.user });
      else if (me.tokenAuth) setAuth({ status: 'token' });
      else setAuth({ status: 'login' });
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
      setToken(r.token);
      setAuth({ status: 'ready', user: r.user });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const logout = () => {
    void authClient.logout(readToken()).catch(() => {});
    localStorage.removeItem(LS_TOKEN_KEY);
    setToken('');
    setAuth({ status: 'login' });
  };

  const applyBase = () => {
    localStorage.setItem(LS_KEY, base);
    window.location.reload();
  };

  if (auth.status === 'loading') {
    return (
      <div className="page">
        <p className="muted center" style={{ marginTop: 80 }}>
          正在连接网关…
        </p>
      </div>
    );
  }

  if (auth.status === 'login') {
    return (
      <LoginCard
        base={base}
        error={auth.error}
        onBaseChange={setBase}
        onApplyBase={applyBase}
        onLogin={doLogin}
      />
    );
  }

  return (
    <Dashboard
      base={base}
      onApplyBase={applyBase}
      onBaseChange={setBase}
      client={client}
      wxClient={wxClient}
      currentUser={auth.status === 'ready' ? auth.user : null}
      authMode={auth.status}
      onLogout={logout}
      onUserUpdated={(user) => setAuth({ status: 'ready', user })}
    />
  );
}

function LoginCard(props: {
  base: string;
  error?: string;
  onBaseChange: (v: string) => void;
  onApplyBase: () => void;
  onLogin: (u: string, p: string) => Promise<string | null>;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(props.error ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setErr(null);
    const e = await props.onLogin(username.trim(), password);
    if (e) setErr(e);
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <form
        className="card login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="login-title">linkagent 后台登录</h1>
        <label className="field">
          <span>网关地址</span>
          <div className="login-base">
            <input value={props.base} onChange={(e) => props.onBaseChange(e.target.value)} spellCheck={false} />
            <button type="button" className="ghost" onClick={props.onApplyBase}>
              切换
            </button>
          </div>
        </label>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoFocus />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            spellCheck={false}
            placeholder="默认 admin / admin123"
          />
        </label>
        {err ? <p className="err">{err}</p> : null}
        <button type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="muted center" style={{ marginBottom: 0 }}>
          初始管理员 admin / admin123，首次登录需修改密码
        </p>
      </form>
    </div>
  );
}

function Dashboard(props: {
  base: string;
  client: GatewayClient;
  wxClient: WeixinClient;
  currentUser: UserPublic | null;
  authMode: 'disabled' | 'token' | 'ready';
  onBaseChange: (v: string) => void;
  onApplyBase: () => void;
  onLogout: () => void;
  onUserUpdated: (u: UserPublic) => void;
}) {
  const { base, client, wxClient, currentUser } = props;
  const token = readToken();
  const [health, setHealth] = useState<AgentInfo[] | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('agent:pi');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [wxStatus, setWxStatus] = useState<WeixinStatus | null>(null);
  const [wxErr, setWxErr] = useState<string | null>(null);
  const [wxQrImage, setWxQrImage] = useState<string | null>(null);
  const [wxScanning, setWxScanning] = useState(false);
  const [wxMsg, setWxMsg] = useState<string | null>(null);
  const wxPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [agents, setAgents] = useState<AgentDetail[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [agentErr, setAgentErr] = useState<string | null>(null);
  const [agentOk, setAgentOk] = useState<string | null>(null);
  const [agentBusyId, setAgentBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(() => {
    const t = localStorage.getItem(LS_TAB_KEY) as TabId | null;
    return t && NAV.some((n) => n.id === t) ? t : 'overview';
  });
  const goTab = (t: TabId) => {
    setTab(t);
    localStorage.setItem(LS_TAB_KEY, t);
  };

  // 会话过期（401）统一登出
  const handleAuthError = useCallback(
    (e: unknown): boolean => {
      if (e instanceof ApiError && e.status === 401) {
        props.onLogout();
        return true;
      }
      return false;
    },
    [props],
  );

  const admin = useCallback(() => new AdminClient(base, token), [base, token]);

  const refreshAgents = useCallback(async () => {
    try {
      const [list, def] = await Promise.all([admin().listAgents(), admin().getDefaultAgent()]);
      setAgents(list);
      setDefaultAgentId(def);
      setAgentErr(null);
    } catch (e) {
      if (handleAuthError(e)) return;
      setAgentErr(e instanceof Error ? e.message : String(e));
    }
  }, [admin, handleAuthError]);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  const refresh = useCallback(async () => {
    try {
      const h = await client.health();
      setHealth(h.agents);
      setHealthErr(null);
    } catch (e) {
      setHealth(null);
      setHealthErr(e instanceof Error ? e.message : String(e));
    }
    try {
      setModels(await client.models());
    } catch (e) {
      handleAuthError(e);
    }
  }, [client, handleAuthError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const refreshWx = useCallback(async () => {
    try {
      setWxStatus(await wxClient.status());
      setWxErr(null);
    } catch (e) {
      setWxErr(e instanceof Error ? e.message : String(e));
    }
  }, [wxClient]);

  useEffect(() => {
    void refreshWx();
    return () => {
      if (wxPollRef.current) clearInterval(wxPollRef.current);
    };
  }, [refreshWx]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: Msg[] = [...messages, { id: ++msgSeq, role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;

    let content = '';
    let reasoning = '';
    try {
      for await (const d of client.streamChat(
        model,
        history.map((m) => ({ role: m.role, content: m.content })),
        abort.signal,
      )) {
        applyDelta(d);
      }
      patchLast((m) => ({ ...m, done: true }));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        if (handleAuthError(e)) return;
        patchLast((m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }

    function applyDelta(d: ChatDelta) {
      if (d.type === 'reasoning' && d.text) {
        reasoning += d.text;
        patchLast((m) => ({ ...m, reasoning }));
      } else if (d.type === 'text' && d.text) {
        content += d.text;
        patchLast((m) => ({ ...m, content }));
      } else if (d.type === 'error' && d.text) {
        patchLast((m) => ({ ...m, error: d.text }));
      }
    }
    function patchLast(fn: (m: Msg) => Msg) {
      setMessages((prev) => {
        const idx = prev.length - 1;
        if (idx < 0 || prev[idx]!.id !== history[history.length - 1]!.id) return prev;
        const next = [...prev];
        next[idx] = fn(next[idx]!);
        return next;
      });
    }
  };

  const stop = () => abortRef.current?.abort();

  const startWxScan = async () => {
    setWxMsg(null);
    setWxScanning(true);
    setWxQrImage(null);
    try {
      const qr = await wxClient.startQr();
      setWxQrImage(qr.qrDataUrl ?? null);
      setWxMsg(qr.qrDataUrl ? '请用手机微信扫一扫完成绑定' : '二维码图片生成失败，请稍后重试');
      const sessionKey = qr.sessionKey;
      if (wxPollRef.current) clearInterval(wxPollRef.current);
      wxPollRef.current = setInterval(async () => {
        try {
          const r = await wxClient.qrStatus(sessionKey, 8_000);
          if (r.connected) {
            if (wxPollRef.current) clearInterval(wxPollRef.current);
            setWxScanning(false);
            setWxMsg(`✅ 绑定成功：账号 ${r.accountId ?? ''}。可点击下方「重启渠道」立即生效，或稍后自动生效。`);
            await refreshWx();
          }
        } catch (e) {
          if (wxPollRef.current) clearInterval(wxPollRef.current);
          setWxScanning(false);
          setWxMsg(`扫码状态查询失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }, 8_000);
    } catch (e) {
      setWxScanning(false);
      setWxMsg(`发起扫码失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const cancelWxScan = () => {
    if (wxPollRef.current) clearInterval(wxPollRef.current);
    wxPollRef.current = null;
    setWxScanning(false);
    setWxQrImage(null);
    setWxMsg(null);
  };

  const reloadWx = async () => {
    setWxMsg('正在重启微信渠道…');
    try {
      await wxClient.reload();
      setWxMsg('✅ 微信渠道已重启');
      await refreshWx();
    } catch (e) {
      setWxMsg(`重启失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const setAsDefault = async (id: string) => {
    setAgentBusyId(id);
    setAgentOk(null);
    setAgentErr(null);
    try {
      const def = await admin().setDefaultAgent(id);
      setDefaultAgentId(def);
      setAgentOk(`已设置默认 agent：${def}`);
      await refreshAgents();
    } catch (e) {
      if (handleAuthError(e)) return;
      setAgentErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusyId(null);
    }
  };

  const toggleEnabled = async (a: AgentDetail) => {
    setAgentBusyId(a.id);
    setAgentOk(null);
    setAgentErr(null);
    try {
      await admin().patchAgent(a.id, { enabled: !a.enabled });
      setAgentOk(`已${a.enabled ? '停用' : '启用'}：${a.id}`);
      await refreshAgents();
    } catch (e) {
      if (handleAuthError(e)) return;
      setAgentErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusyId(null);
    }
  };

  return (
    <div className="page">
      {currentUser?.mustChangePassword ? (
        <ChangePasswordModal user={currentUser} onDone={props.onUserUpdated} onLogout={props.onLogout} />
      ) : null}

      <header>
        <h1>linkagent 后台</h1>
        <div className="gw-bar">
          <input value={base} onChange={(e) => props.onBaseChange(e.target.value)} spellCheck={false} placeholder="网关地址" />
          <button onClick={props.onApplyBase}>切换</button>
          <button className="ghost" onClick={() => void refresh()}>
            刷新
          </button>
          <span className={`dot ${health ? 'ok' : 'bad'}`} />
          <span className="gw-state">{healthErr ?? (health ? `${health.length} agent` : '—')}</span>
          <span className="spacer" />
          {currentUser ? (
            <span className="user-chip">
              {currentUser.role === 'admin' ? <span className="role-badge">管理员</span> : null}
              <code>{currentUser.displayName || currentUser.username}</code>
              <button className="ghost small" onClick={props.onLogout}>
                退出
              </button>
            </span>
          ) : props.authMode === 'token' ? (
            <span className="user-chip">
              <span className="muted">API Key 模式</span>
              <button className="ghost small" onClick={props.onLogout}>
                清除
              </button>
            </span>
          ) : null}
        </div>
      </header>

      <div className="shell-body">
      <nav className="side-nav">
        {NAV.filter((n) => !n.adminOnly || currentUser?.role === 'admin').map((n) => (
          <button key={n.id} className={tab === n.id ? 'active' : ''} onClick={() => goTab(n.id)}>
            {n.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'agents' ? (
        <section className="card">
          <h2>
            网关 Agents
            {agentOk ? <span className="ok-text">{agentOk}</span> : null}
          </h2>
          {agentErr ? <p className="err">{agentErr}</p> : null}
          {agents ? (
            <ul className="agents">
              {agents.map((a) => (
                <li key={a.id} className={a.id === defaultAgentId ? 'default' : ''}>
                  <div className="agent-main">
                    <code>{a.id}</code>
                    {a.displayName && a.displayName !== a.id ? <span className="name">{a.displayName}</span> : null}
                    {a.description ? <span className="desc">{a.description}</span> : null}
                  </div>
                  <div className="agent-ops">
                    {a.id === defaultAgentId ? <span className="badge">默认</span> : null}
                    <span className={`state ${a.enabled ? 'on' : 'off'}`}>{a.enabled ? '启用' : '停用'}</span>
                    <button
                      className="ghost small"
                      disabled={a.id === defaultAgentId || agentBusyId === a.id}
                      onClick={() => void setAsDefault(a.id)}
                    >
                      设为默认
                    </button>
                    <button className="ghost small" disabled={agentBusyId === a.id} onClick={() => void toggleEnabled(a)}>
                      {a.enabled ? '停用' : '启用'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </section>
        ) : null}

        {tab === 'settings' && (props.authMode !== 'ready' || currentUser?.role === 'admin') ? (
          <SystemSettings
            base={base}
            onBaseChange={props.onBaseChange}
            onApplyBase={props.onApplyBase}
            onAuthError={handleAuthError}
          />
        ) : null}

        {tab === 'accounts' && currentUser?.role === 'admin' ? <UserManagement /> : null}

        {tab === 'weixin' ? (
        <section className="card">
          <h2>聊天机器人绑定</h2>
          {wxErr ? <p className="err">{wxErr}</p> : null}
          {wxStatus ? (
            <div>
              <p>
                绑定状态：{' '}
                {wxStatus.configured ? (
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>已绑定</span>
                ) : (
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>未绑定</span>
                )}
                {wxStatus.activeAccountId ? `（当前账号 ${wxStatus.activeAccountId}）` : ''}
              </p>
              {wxStatus.accounts.length > 0 ? (
                <ul style={{ fontSize: 13, color: '#555' }}>
                  {wxStatus.accounts.map((a) => (
                    <li key={a.id}>
                      <code>{a.id}</code>
                      {a.userId ? ` · ${a.userId}` : ''}
                      {a.savedAt ? ` · ${a.savedAt}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={() => void startWxScan()} disabled={wxScanning}>
                  {wxScanning ? '等待扫码…' : wxStatus.configured ? '重新绑定' : '绑定微信机器人'}
                </button>
                {wxScanning ? (
                  <button className="ghost" onClick={cancelWxScan}>
                    取消
                  </button>
                ) : null}
                {wxStatus.configured ? (
                  <button className="ghost" onClick={() => void reloadWx()}>
                    重启渠道
                  </button>
                ) : null}
              </div>
              {wxQrImage ? (
                <div style={{ marginTop: 12 }}>
                  <img src={wxQrImage} alt="微信绑定二维码" style={{ width: 220, height: 220, border: '1px solid #ddd', borderRadius: 8 }} />
                </div>
              ) : null}
              {wxMsg ? <p style={{ marginTop: 10, fontSize: 13 }}>{wxMsg}</p> : null}
            </div>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </section>
        ) : null}

        {tab === 'tasks' ? <TasksCard base={base} token={token} onAuthError={handleAuthError} /> : null}
        {tab === 'keys' ? <KeysCard base={base} token={token} onAuthError={handleAuthError} /> : null}
        {tab === 'channel-tokens' && currentUser?.role === 'admin' ? (
          <ChannelTokensCard base={base} token={token} onAuthError={handleAuthError} />
        ) : null}
        {tab === 'nodes' ? <NodesCard base={base} token={token} onAuthError={handleAuthError} /> : null}

        {tab === 'overview' ? (
        <>
        <section className="card">
          <ul className="models">
            {models.map((m) => (
              <li key={m.id} className={m.id === model ? 'active' : ''} onClick={() => setModel(m.id)} title={m.description}>
                <code>{m.id}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="card chat">
          <h2>
            聊天测试台
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </h2>

          <div className="thread">
            {messages.length === 0 ? (
              <p className="muted center">向网关发一条消息测试流式回复（思考流与正文分开展示）</p>
            ) : null}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="who">{m.role === 'user' ? '你' : 'agent'}</div>
                {m.reasoning ? <div className="reasoning">🤔 {m.reasoning}</div> : null}
                {m.content ? <div className="content">{m.content}</div> : null}
                {m.error ? <div className="err">⚠️ {m.error}</div> : null}
                {!m.content && !m.error && !m.done ? <div className="cursor" /> : null}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void send();
              }}
              placeholder="输入消息，Enter 发送"
              disabled={busy}
            />
            {busy ? (
              <button onClick={stop}>停止</button>
            ) : (
              <button onClick={() => void send()} disabled={!input.trim()}>
                发送
              </button>
            )}
          </div>
        </section>
        </>
        ) : null}
      </main>
      </div>
    </div>
  );
}

// ── 任务管理（对齐旧 admin.html：按渠道用户分组，新建/改名/换 agent/激活/删除 + 偏好）──
function TasksCard(props: { base: string; token: string; onAuthError: (e: unknown) => boolean }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [agents, setAgents] = useState<{ id: string; displayName?: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [target, setTarget] = useState<{ channel: string; userId: string } | null>(null);
  const [form, setForm] = useState({ name: '', agentId: '', nodeId: '', key: '', cwd: '' });

  const load = useCallback(async () => {
    try {
      const [u, na] = await Promise.all([ops.listAllTasks(), ops.nodeAgents()]);
      setUsers(u);
      setNodes(na.nodes);
      setAgents(na.agents);
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    }
  }, [ops, props]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      if (ok) setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = (channel: string, userId: string) => {
    setTarget({ channel, userId });
    setForm({ name: '', agentId: agents[0]?.id ?? '', nodeId: '', key: '', cwd: '' });
    setShowCreate(true);
  };

  const submitCreate = () => {
    if (!target || !form.name.trim()) return;
    void run(async () => {
      await ops.createTask({
        channel: target.channel,
        userId: target.userId,
        name: form.name.trim(),
        ...(form.agentId ? { agentId: form.agentId } : {}),
        ...(form.nodeId ? { nodeId: form.nodeId } : {}),
        ...(form.key.trim() ? { key: form.key.trim() } : {}),
        ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      });
      setShowCreate(false);
    });
  };

  return (
    <section className="card wide">
      <h2>任务管理</h2>
      {err ? <p className="err">{err}</p> : null}
      {users === null ? (
        <p className="muted">加载中…</p>
      ) : users.length === 0 ? (
        <p className="muted">暂无渠道用户任务（微信用户发起对话后自动创建）</p>
      ) : (
        users.map((u) => (
          <div key={`${u.channel}:${u.userId}`} className="task-group">
            <div className="task-group-head">
              <code>
                {u.channel}:{u.userId}
              </code>
              <span className="muted">当前任务 {u.activeTaskId}</span>
              <button className="ghost small" onClick={() => openCreate(u.channel, u.userId)}>
                + 新建任务
              </button>
            </div>
            <table className="grid">
              <thead>
                <tr>
                  <th>任务名</th>
                  <th>Key</th>
                  <th>Agent</th>
                  <th>节点</th>
                  <th>cwd</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {u.tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    u={u}
                    t={t}
                    busy={busy}
                    nodes={nodes}
                    agents={agents}
                    onRename={(name) => run(() => ops.patchTask(u.channel, u.userId, t.id, { name }))}
                    onCwd={(cwd) => run(() => ops.patchTask(u.channel, u.userId, t.id, { cwd: cwd || null }))}
                    onAgent={(agentId, nodeId) => run(() => ops.setTaskAgent(u.channel, u.userId, t.id, agentId, nodeId))}
                    onActivate={() => run(() => ops.activateTask(u.channel, u.userId, t.id))}
                    onDelete={async () => {
                      if (confirm(`删除任务「${t.name}」？`)) await run(() => ops.deleteTask(u.channel, u.userId, t.id));
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {showCreate && target ? (
        <div className="modal-mask" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>新建任务（{target.userId}）</h3>
            <label>任务名 *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：默认任务" />
            <label>Agent</label>
            <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">（默认）</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName || a.id}
                </option>
              ))}
            </select>
            <label>运行节点</label>
            <select value={form.nodeId} onChange={(e) => setForm({ ...form, nodeId: e.target.value })}>
              <option value="">本机</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.name}
                </option>
              ))}
            </select>
            <label>Key（留空自动生成）</label>
            <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            <label>工作目录 cwd</label>
            <input value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
            <div className="modal-ops">
              <button className="ghost" onClick={() => setShowCreate(false)}>
                取消
              </button>
              <button onClick={submitCreate} disabled={busy || !form.name.trim()}>
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TaskRow(props: {
  u: UserTasks;
  t: TaskItem;
  busy: boolean;
  nodes: NodeInfo[];
  agents: { id: string; displayName?: string }[];
  onRename: (name: string) => Promise<unknown>;
  onCwd: (cwd: string) => Promise<unknown>;
  onAgent: (agentId: string, nodeId?: string) => Promise<unknown>;
  onActivate: () => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const { u, t } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [cwd, setCwd] = useState(t.cwd ?? '');
  const [agentId, setAgentId] = useState(t.agentId);
  const [nodeId, setNodeId] = useState(t.nodeId ?? '');
  const isActive = u.activeTaskId === t.id;

  if (!editing) {
    return (
      <tr className={isActive ? 'active-row' : ''}>
        <td>
          {isActive ? <span className="badge">当前</span> : null} {t.name}
        </td>
        <td>
          <code>{t.key ? `${t.key.slice(0, 10)}…` : '—'}</code>
        </td>
        <td>{t.agentId}</td>
        <td>{t.nodeId || '本机'}</td>
        <td className="muted">{t.cwd || '—'}</td>
        <td className="row-ops">
          {!isActive ? (
            <button className="ghost small" disabled={props.busy} onClick={props.onActivate}>
              激活
            </button>
          ) : null}
          <button className="ghost small" onClick={() => setEditing(true)}>
            编辑
          </button>
          <button className="danger small" disabled={props.busy} onClick={props.onDelete}>
            删除
          </button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <code>{t.key ? `${t.key.slice(0, 10)}…` : '—'}</code>
      </td>
      <td>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName || a.id}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          <option value="">本机</option>
          {props.nodes.map((n) => (
            <option key={n.nodeId} value={n.nodeId}>
              {n.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="cwd" />
      </td>
      <td className="row-ops">
        <button
          className="small"
          disabled={props.busy}
          onClick={() => {
            void (async () => {
              if (name.trim() && name !== t.name) props.onRename(name.trim());
              if (cwd.trim() !== (t.cwd ?? '')) props.onCwd(cwd.trim());
              if (agentId !== t.agentId || nodeId !== (t.nodeId ?? '')) props.onAgent(agentId, nodeId || undefined);
              setEditing(false);
            })();
          }}
        >
          保存
        </button>
        <button className="ghost small" onClick={() => setEditing(false)}>
          取消
        </button>
      </td>
    </tr>
  );
}

// ── Key 管理（由任务派生：展示每个任务的 key，可启停）──
function KeysCard(props: { base: string; token: string; onAuthError: (e: unknown) => boolean }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await ops.listAllTasks());
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    }
  }, [ops, props]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all: { u: UserTasks; t: TaskItem }[] = [];
    (users ?? []).forEach((u) => u.tasks.forEach((t) => all.push({ u, t })));
    const withKey = all.filter((r) => !!r.t.key);
    const kw = q.trim().toLowerCase();
    return kw
      ? withKey.filter((r) => (r.t.key! + r.t.name + r.u.userId).toLowerCase().includes(kw))
      : withKey;
  }, [users, q]);

  const toggle = (u: UserTasks, t: TaskItem) => {
    setBusyKey(t.id);
    setErr(null);
    void ops
      .patchTask(u.channel, u.userId, t.id, { keyEnabled: t.keyEnabled === false })
      .then(() => load())
      .catch((e) => {
        if (props.onAuthError(e)) return;
        setErr(errText(e));
      })
      .finally(() => setBusyKey(null));
  };

  const copy = (key: string) => {
    void navigator.clipboard?.writeText(key).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    });
  };

  return (
    <section className="card wide">
      <h2>Key 管理</h2>
      <p className="muted">
        任务 key 随任务自动生成，可直接填入 Chatbox/任意 OpenAI 客户端的 <code>API Key</code>（即
        <code> Bearer &lt;key&gt;</code>）任务级直连，无需全局静态 token 与 channel/userId/task；
        该凭据只能访问这一个任务且不能切换 agent。停用后该 Key 立即失效。
      </p>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 Key / 任务 / 用户" />
      {err ? <p className="err">{err}</p> : null}
      {users === null ? (
        <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">暂无 Key</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Key</th>
              <th>所属用户</th>
              <th>任务</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ u, t }) => {
              const enabled = t.keyEnabled !== false;
              return (
                <tr key={t.id}>
                  <td>
                    <code>{t.key}</code>
                  </td>
                  <td>
                    {u.channel}:{u.userId}
                  </td>
                  <td>{t.name}</td>
                  <td>
                    <span className={`state ${enabled ? 'on' : 'off'}`}>{enabled ? '启用' : '停用'}</span>
                  </td>
                  <td className="row-ops">
                    <button className="ghost small" onClick={() => t.key && copy(t.key)}>
                      {copied === t.key ? '已复制' : '复制'}
                    </button>
                    <button className="ghost small" disabled={busyKey === t.id} onClick={() => toggle(u, t)}>
                      {enabled ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── 渠道用户级凭据（微信 bot 按用户直连网关的 ct_ token）──
function ChannelTokensCard(props: { base: string; token: string; onAuthError: (e: unknown) => boolean }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [rows, setRows] = useState<ChannelTokenInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // 签发/轮换后临时回显完整 token（列表接口不回显，仅此一次展示，便于复制配置）
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [channel, setChannel] = useState('weixin');
  const [userId, setUserId] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await ops.listChannelTokens());
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    }
  }, [ops, props]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1200);
    });
  };

  const run = async (id: string, fn: () => Promise<{ token: string } | void>) => {
    setBusyKey(id);
    setErr(null);
    try {
      const r = await fn();
      if (r && 'token' in r) setRevealed({ id, token: (r as { token: string }).token });
      await load();
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  const rowId = (r: ChannelTokenInfo) => `${r.channel}:${r.userId}`;

  return (
    <section className="card wide">
      <h2>用户凭据</h2>
      <p className="muted">
        每个微信用户一枚用户级 token（ct_ 前缀），微信 bot 代该用户直连网关，只能访问其本人的任务，不能触碰管理接口。
        Chatbox 任务级直连请用「Key 管理」里的任务 key（直接把 key 填入 API Key 即可）。
      </p>

      <div className="inline-form">
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="weixin">weixin</option>
        </select>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="微信用户 id（from_user_id）"
        />
        <button
          disabled={!userId.trim() || busyKey === 'ensure'}
          onClick={() =>
            void run('ensure', () => ops.ensureChannelToken(channel.trim(), userId.trim())).then(() => setUserId(''))
          }
        >
          {busyKey === 'ensure' ? '处理中…' : '获取 / 签发'}
        </button>
      </div>

      {revealed ? (
        <div className="token-reveal">
          <span className="muted">完整 token（仅显示一次，请妥善复制）：</span>
          <code>{revealed.token}</code>
          <button className="ghost small" onClick={() => copy('revealed', revealed.token)}>
            {copied === 'revealed' ? '已复制' : '复制'}
          </button>
          <button className="ghost small" onClick={() => setRevealed(null)}>
            关闭
          </button>
        </div>
      ) : null}

      {err ? <p className="err">{err}</p> : null}
      {rows === null ? (
        <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">暂无用户凭据（微信用户首次发消息时自动签发）</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>凭据</th>
              <th>所属用户</th>
              <th>签发时间</th>
              <th>最近使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = rowId(r);
              return (
                <tr key={id}>
                  <td>
                    <code>{r.tokenPreview}</code>
                  </td>
                  <td>
                    {r.channel}:{r.userId}
                  </td>
                  <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="muted">{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : '—'}</td>
                  <td className="row-ops">
                    <button
                      className="ghost small"
                      disabled={busyKey === `rotate:${id}`}
                      onClick={() => void run(`rotate:${id}`, () => ops.rotateChannelToken(r.channel, r.userId))}
                    >
                      轮换
                    </button>
                    <button
                      className="ghost small danger"
                      disabled={busyKey === `revoke:${id}`}
                      onClick={() => {
                        if (!window.confirm(`确认吊销 ${id} 的用户凭据？bot 下次消息将自动重新签发。`)) return;
                        void run(`revoke:${id}`, () => ops.revokeChannelTokenByUser(r.channel, r.userId));
                      }}
                    >
                      吊销
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── 节点管理（准入审批、在线/离线、接入指引、删除）──
function NodesCard(props: { base: string; token: string; onAuthError: (e: unknown) => boolean }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);

  const load = useCallback(async () => {
    try {
      setNodes(await ops.listNodes());
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(errText(e));
    }
  }, [ops, props]);

  useEffect(() => {
    void load();
    // 有待审批节点时加快轮询，便于批准后及时刷新
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const guard = (id: string) => (action: Promise<unknown>) => {
    setBusyId(id);
    setErr(null);
    action
      .then(load)
      .catch((e) => {
        if (props.onAuthError(e)) return;
        setErr(errText(e));
      })
      .finally(() => setBusyId(null));
  };

  const approve = (n: NodeInfo) => guard(n.nodeId)(ops.approveNode(n.nodeId));
  const reject = (n: NodeInfo) => {
    if (!confirm(`拒绝节点「${n.name}」接入？拒绝后其连接会被断开且无法重连（删除记录后可重新申请）。`)) return;
    guard(n.nodeId)(ops.rejectNode(n.nodeId));
  };
  const remove = (n: NodeInfo) => {
    const tip =
      n.status === 'pending'
        ? `删除待审批节点「${n.name}」？对端需重新发起申请。`
        : `删除节点「${n.name}」的注册信息？（离线节点可删除，在线节点会重新注册）`;
    if (!confirm(tip)) return;
    guard(n.nodeId)(ops.deleteNode(n.nodeId));
  };

  const pending = (nodes ?? []).filter((n) => n.status === 'pending');

  return (
    <section className="card wide">
      <div className="card-head">
        <h2>节点管理</h2>
        <button className="small" onClick={() => setShowEnroll((v) => !v)}>
          {showEnroll ? '收起接入指引' : '接入新机器'}
        </button>
      </div>
      {err ? <p className="err">{err}</p> : null}

      {showEnroll ? <NodeEnrollPanel base={props.base} token={props.token} onAuthError={props.onAuthError} /> : null}

      {pending.length > 0 ? (
        <div className="node-pending-banner">
          <strong>{pending.length} 个节点等待审批</strong>
          <span className="muted">批准后才可被任务绑定与调用</span>
        </div>
      ) : null}

      {nodes === null ? (
        <p className="muted">加载中…</p>
      ) : nodes.length === 0 ? (
        <p className="muted">暂无远程节点（本机网关始终可用）</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>节点</th>
              <th>状态</th>
              <th>版本</th>
              <th>Agents</th>
              <th>最近连接</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const isLocal = n.nodeId === 'local';
              const isPending = n.status === 'pending';
              const isBlocked = n.status === 'blocked';
              return (
                <tr key={n.nodeId} className={isPending ? 'row-pending' : undefined}>
                  <td>
                    <code>{n.name}</code>
                    {!isLocal ? <div className="muted small-text">{n.nodeId}</div> : null}
                  </td>
                  <td>
                    {isPending ? (
                      <span className="state pending">待审批</span>
                    ) : isBlocked ? (
                      <span className="state blocked">已拒绝</span>
                    ) : (
                      <span className={`state ${n.online ? 'on' : 'off'}`}>{n.online ? '在线' : '离线'}</span>
                    )}
                  </td>
                  <td>{n.version || '—'}</td>
                  <td>{n.agents.map((a) => a.id).join(', ') || '—'}</td>
                  <td>{n.online || isPending ? relTime(n.connectedAt ?? n.lastSeenAt ?? 0) : relTime(n.lastSeenAt ?? 0)}</td>
                  <td className="row-ops">
                    {isLocal ? (
                      <span className="muted">内建</span>
                    ) : isPending ? (
                      <>
                        <button className="small primary" disabled={busyId === n.nodeId} onClick={() => approve(n)}>
                          批准
                        </button>
                        <button className="small danger" disabled={busyId === n.nodeId} onClick={() => reject(n)}>
                          拒绝
                        </button>
                        <button className="small" disabled={busyId === n.nodeId} onClick={() => remove(n)}>
                          删除
                        </button>
                      </>
                    ) : (
                      <button className="danger small" disabled={n.online || busyId === n.nodeId} onClick={() => remove(n)}>
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 由当前后台访问地址推导节点机应使用的网关 WS 地址（主机名用浏览器侧，端口用网关配置） */
function guessGatewayUrl(port: number): string {
  if (typeof window === 'undefined') return `ws://GATEWAY_HOST:${port}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname || 'GATEWAY_HOST';
  return `${proto}://${host}:${port}`;
}

// ── 节点接入指引：令牌直连 / 申请审批 两种方式，生成 env 与启动命令 ──
function NodeEnrollPanel(props: { base: string; token: string; onAuthError: (e: unknown) => boolean }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [info, setInfo] = useState<NodeEnrollInfo | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState('node-1');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ops
      .nodeEnroll()
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        setUrl(guessGatewayUrl(i.port));
        setAgents(Object.fromEntries(i.defaultAgents.map((a) => [a.id, true])));
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setLoadErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [ops]);

  const copy = (key: string, text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      })
      .catch(() => undefined);
  };

  if (forbidden) {
    return (
      <div className="enroll-box">
        <p className="muted">仅管理员可查看节点接入命令（含网关令牌）。请使用管理员账号登录。</p>
      </div>
    );
  }
  if (loadErr) {
    return (
      <div className="enroll-box">
        <p className="err">{loadErr}</p>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="enroll-box">
        <p className="muted">加载接入信息…</p>
      </div>
    );
  }

  const instName = name.trim() || 'node-1';
  const chosenAgents = Object.keys(agents).filter((id) => agents[id]);
  const agentsLine = chosenAgents.length > 0 ? chosenAgents.join(',') : info.defaultAgents.map((a) => a.id).join(',');
  const envPath = `.runtime-state/node-${instName}.env`;
  const startCmd = `pnpm node:start ${instName}`;

  const envDirect = [
    `LINKAGENT_GATEWAY_URL=${url}`,
    ...(info.authEnabled && info.token ? [`LINKAGENT_GATEWAY_TOKEN=${info.token}`] : []),
    `LINKAGENT_NODE_AGENTS=${agentsLine}`,
  ].join('\n');

  const envApproval = [`LINKAGENT_GATEWAY_URL=${url}`, `LINKAGENT_NODE_AGENTS=${agentsLine}`].join('\n');

  const localHost = /(^|\.)(127\.0\.0\.1|localhost)$/.test(new URL(url).hostname) || new URL(url).hostname === '::1';

  return (
    <div className="enroll-box">
      <div className="enroll-form">
        <label>
          节点实例名
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-1" />
        </label>
        <label className="grow">
          网关地址（节点机可达）
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://gw.example.com" />
        </label>
      </div>
      <div className="enroll-agents">
        <span>上报 Agent：</span>
        {info.defaultAgents.map((a) => (
          <label key={a.id} className="chip">
            <input
              type="checkbox"
              checked={agents[a.id] ?? false}
              onChange={(e) => setAgents((s) => ({ ...s, [a.id]: e.target.checked }))}
            />
            {a.displayName || a.id}
          </label>
        ))}
      </div>
      {localHost ? <p className="muted small-text">当前地址指向回环地址，仅适用于节点与网关同机；跨机请改成网关机 IP 或域名。</p> : null}

      <ol className="enroll-steps">
        <li>执行机准备 Node ≥ 22.13、pnpm，安装代码/发布包及所需 agent CLI。</li>
        <li>在项目根目录创建 <code>{envPath}</code>，选择下列任一方式。</li>
        <li>
          运行 <code>{startCmd}</code>（前台调试可用 <code>pnpm node:dev {instName}</code>）。
        </li>
      </ol>

      <div className="enroll-modes">
        <div className="enroll-mode">
          <div className="enroll-mode-head">
            <strong>方式一 · 令牌直连</strong>
            <span className="muted small-text">env 含令牌，连上即上线，无需审批</span>
          </div>
          {info.authEnabled ? null : <p className="muted small-text">网关当前未开启鉴权，无需令牌，任意连接自动上线。</p>}
          <pre>{envDirect}</pre>
          <button className="small" onClick={() => copy('direct', envDirect)}>
            {copied === 'direct' ? '已复制' : '复制 env'}
          </button>
        </div>
        <div className="enroll-mode">
          <div className="enroll-mode-head">
            <strong>方式二 · 申请审批</strong>
            <span className="muted small-text">env 不含令牌；启动后在本页顶部待审批区点「批准」</span>
          </div>
          <pre>{envApproval}</pre>
          <button className="small" onClick={() => copy('approval', envApproval)}>
            {copied === 'approval' ? '已复制' : '复制 env'}
          </button>
        </div>
      </div>

      <div className="enroll-cmd">
        <code>{startCmd}</code>
        <button className="small" onClick={() => copy('cmd', startCmd)}>
          {copied === 'cmd' ? '已复制' : '复制命令'}
        </button>
      </div>
      <p className="muted small-text">
        审批通过后网关会向节点签发专属凭证并保存在节点机 <code>.runtime-state/node-{instName}/node-secret</code>，
        此后断线重连无需再次审批；被拒绝的节点会停止重连，需删除记录后重新申请。
      </p>
    </div>
  );
}

function ChangePasswordModal(props: { user: UserPublic; onDone: (u: UserPublic) => void; onLogout: () => void }) {
  const base = localStorage.getItem(LS_KEY) ?? DEFAULT_BASE;
  const client = new AuthClient(base);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (newPwd.length < 8) return setErr('新密码长度至少 8 位');
    if (newPwd !== confirm) return setErr('两次输入的新密码不一致');
    if (newPwd === oldPwd) return setErr('新密码不能与旧密码相同');
    setBusy(true);
    setErr(null);
    try {
      await client.changePassword(readToken(), oldPwd, newPwd);
      props.onDone({ ...props.user, mustChangePassword: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask">
      <form
        className="card modal"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>首次登录请修改密码</h2>
        <p className="muted">为了账号安全，使用默认密码首次登录必须修改密码后才能继续。</p>
        <label className="field">
          <span>原密码</span>
          <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>新密码（至少 8 位）</span>
          <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
        </label>
        <label className="field">
          <span>确认新密码</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {err ? <p className="err">{err}</p> : null}
        <div className="modal-ops">
          <button type="button" className="ghost" onClick={props.onLogout}>
            退出登录
          </button>
          <button type="submit" disabled={busy || !oldPwd || !newPwd || !confirm}>
            {busy ? '提交中…' : '确认修改'}
          </button>
        </div>
      </form>
    </div>
  );
}

function UserManagement() {
  const base = localStorage.getItem(LS_KEY) ?? DEFAULT_BASE;
  const client = new UserAdminClient(base, readToken);
  const [users, setUsers] = useState<UserPublic[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [nu, setNu] = useState({ username: '', password: '', role: 'user' as 'admin' | 'user', displayName: '' });
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState('');

  const refresh = useCallback(async () => {
    try {
      setUsers(await client.list());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createUser = async () => {
    if (!nu.username.trim() || !nu.password) return;
    setBusyUser('__new__');
    setErr(null);
    setOk(null);
    try {
      await client.create({
        username: nu.username.trim(),
        password: nu.password,
        role: nu.role,
        ...(nu.displayName.trim() ? { displayName: nu.displayName.trim() } : {}),
      });
      setOk(`已创建用户：${nu.username.trim()}（首次登录需改密）`);
      setNu({ username: '', password: '', role: 'user', displayName: '' });
      setShowCreate(false);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  const removeUser = async (u: UserPublic) => {
    if (!window.confirm(`确认删除用户 ${u.username}？该用户的登录会话将同时失效。`)) return;
    setBusyUser(u.username);
    setErr(null);
    setOk(null);
    try {
      await client.remove(u.username);
      setOk(`已删除用户：${u.username}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    if (resetPwd.length < 8) {
      setErr('新密码长度至少 8 位');
      return;
    }
    setBusyUser(resetTarget);
    setErr(null);
    setOk(null);
    try {
      await client.resetPassword(resetTarget, resetPwd);
      setOk(`已重置 ${resetTarget} 的密码（其下次登录需改密）`);
      setResetTarget(null);
      setResetPwd('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <section className="card">
      <h2>
        用户管理
        <button className="small" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? '取消' : '新增用户'}
        </button>
      </h2>
      {err ? <p className="err">{err}</p> : null}
      {ok ? <p className="ok-text">{ok}</p> : null}

      {showCreate ? (
        <div className="user-form">
          <input
            placeholder="用户名（字母数字 . _ -）"
            value={nu.username}
            spellCheck={false}
            onChange={(e) => setNu({ ...nu, username: e.target.value })}
          />
          <input
            placeholder="初始密码（至少 8 位）"
            type="text"
            value={nu.password}
            onChange={(e) => setNu({ ...nu, password: e.target.value })}
          />
          <input
            placeholder="显示名（可选）"
            value={nu.displayName}
            onChange={(e) => setNu({ ...nu, displayName: e.target.value })}
          />
          <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as 'admin' | 'user' })}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <button className="small" disabled={busyUser === '__new__' || !nu.username.trim() || nu.password.length < 8} onClick={() => void createUser()}>
            创建
          </button>
        </div>
      ) : null}

      {users ? (
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.username}>
              <div className="agent-main">
                <code>{u.username}</code>
                {u.role === 'admin' ? <span className="role-badge">管理员</span> : <span className="role-badge muted-role">用户</span>}
                {u.displayName ? <span className="desc">{u.displayName}</span> : null}
                {u.mustChangePassword ? <span className="state" style={{ color: 'var(--reason)' }}>待改密</span> : null}
              </div>
              <div className="agent-ops">
                {resetTarget === u.username ? (
                  <span className="reset-row">
                    <input
                      type="text"
                      placeholder="新密码（≥8 位）"
                      value={resetPwd}
                      onChange={(e) => setResetPwd(e.target.value)}
                    />
                    <button className="small" disabled={busyUser === u.username} onClick={() => void submitReset()}>
                      确认
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => {
                        setResetTarget(null);
                        setResetPwd('');
                      }}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <button className="ghost small" disabled={busyUser === u.username} onClick={() => { setResetTarget(u.username); setResetPwd(''); setErr(null); }}>
                      重置密码
                    </button>
                    <button className="ghost small" disabled={busyUser === u.username} onClick={() => void removeUser(u)}>
                      删除
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">加载中…</p>
      )}
    </section>
  );
}

/** 网关设置（连接管理 + 只读信息）与本机进程管理，仅管理员可见；进程卡片仅本机访问时出现 */
function SystemSettings(props: {
  base: string;
  onBaseChange: (v: string) => void;
  onApplyBase: () => void;
  onAuthError: (e: unknown) => boolean;
}) {
  const client = new PmClient(props.base, readToken);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const i = await client.systemInfo();
        if (alive) {
          setInfo(i);
          setInfoErr(null);
        }
      } catch (e) {
        if (props.onAuthError(e)) return;
        if (alive) setInfoErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.base]);

  return (
    <>
      <section className="card">
        <h2>网关设置</h2>
        {infoErr ? <p className="err">{infoErr}</p> : null}
        <label className="field">
          <span>网关连接地址（可外接远程网关，切换后整页重连）</span>
          <div className="login-base">
            <input value={props.base} onChange={(e) => props.onBaseChange(e.target.value)} spellCheck={false} />
            <button type="button" className="ghost small" onClick={props.onApplyBase}>
              切换并重连
            </button>
          </div>
        </label>
        {info ? (
          <ul className="gw-meta">
            <li>
              <span className="muted">来源</span>
              {info.local ? <span className="state on">本机</span> : <span className="state off">远程网关</span>}
            </li>
            <li>
              <span className="muted">监听地址</span>
              <code>
                {info.host}:{info.port}
              </code>
            </li>
            <li>
              <span className="muted">访问鉴权</span>
              <code>{info.authEnabled ? '已开启' : '未开启（仅本地开发）'}</code>
            </li>
            <li>
              <span className="muted">登录会话有效期</span>
              <code>{info.sessionTtlDays} 天</code>
            </li>
          </ul>
        ) : (
          <p className="muted">加载中…</p>
        )}
      </section>

      {info?.local ? <ProcessManagerCard client={client} onAuthError={props.onAuthError} /> : null}
    </>
  );
}

function ProcessManagerCard(props: { client: PmClient; onAuthError: (e: unknown) => boolean }) {
  const { client } = props;
  const [procs, setProcs] = useState<PmProcess[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restartingGw, setRestartingGw] = useState(false);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [logBusy, setLogBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProcs(await client.status());
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (id: string, op: 'start' | 'stop' | 'restart') => {
    if (op === 'restart' && id === 'gateway') {
      if (!window.confirm('确认重启网关？期间网页与 OpenAI 接口会短暂中断（约数秒），微信/节点会自动重连。')) return;
    }
    setBusyId(`${id}:${op}`);
    setErr(null);
    try {
      if (op === 'start') setProcs(await client.start([id]));
      else if (op === 'stop') setProcs(await client.stop([id]));
      else {
        const r = await client.restart([id]);
        if (r.gateway) {
          // 网关自重启：本进程即将退出，轮询健康直到恢复
          setRestartingGw(true);
          await waitGatewayBack(client);
          setRestartingGw(false);
        }
        if (r.processes) setProcs(r.processes);
      }
      await refresh();
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
      setRestartingGw(false);
    } finally {
      setBusyId(null);
    }
  };

  const openLog = async (id: string) => {
    if (logFor === id) {
      setLogFor(null);
      return;
    }
    setLogFor(id);
    setLogBusy(true);
    try {
      setLogText(await client.logs(id, 200));
    } catch (e) {
      if (props.onAuthError(e)) return;
      setLogText(`读取日志失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLogBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>
        进程管理
        <button className="ghost small" onClick={() => void refresh()}>
          刷新
        </button>
      </h2>
      {err ? <p className="err">{err}</p> : null}
      {restartingGw ? <p className="ok-text">网关重启中，等待恢复…</p> : null}
      {procs ? (
        <ul className="pm-list">
          {procs.map((p) => {
            const busy = busyId?.startsWith(`${p.id}:`) ?? false;
            return (
              <li key={p.id}>
                <div className="agent-main">
                  <span className={`dot ${p.running ? 'ok' : 'bad'}`} />
                  <code>{p.label}</code>
                  <span className={`state ${p.running ? 'on' : 'off'}`}>
                    {p.running ? `运行中${p.pid ? ` · pid ${p.pid}` : ''}` : '已停止'}
                  </span>
                </div>
                <div className="agent-ops">
                  {p.id === 'gateway' ? (
                    <button className="ghost small" disabled={busy || restartingGw} onClick={() => void act(p.id, 'restart')}>
                      重启
                    </button>
                  ) : (
                    <>
                      <button className="ghost small" disabled={busy || p.running} onClick={() => void act(p.id, 'start')}>
                        启动
                      </button>
                      <button className="ghost small" disabled={busy || !p.running} onClick={() => void act(p.id, 'stop')}>
                        停止
                      </button>
                      <button className="ghost small" disabled={busy} onClick={() => void act(p.id, 'restart')}>
                        重启
                      </button>
                    </>
                  )}
                  <button className="ghost small" onClick={() => void openLog(p.id)}>
                    {logFor === p.id ? '收起日志' : '日志'}
                  </button>
                </div>
                {logFor === p.id ? (
                  <pre className="pm-log">{logBusy ? '读取中…' : logText || '（暂无日志）'}</pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">加载中…</p>
      )}
    </section>
  );
}

/** 网关重启后轮询 /api/system/info 直到恢复（最多 ~40s） */
async function waitGatewayBack(client: PmClient, timeoutMs = 40_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      await client.systemInfo();
      return;
    } catch {
      if (Date.now() - start > timeoutMs) return;
    }
  }
}
