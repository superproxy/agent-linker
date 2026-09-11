import { useCallback, useEffect, useRef, useState } from 'react';
import { GatewayClient, WeixinClient, type AgentInfo, type ChatDelta, type ModelInfo, type WeixinStatus } from './api';

const DEFAULT_BASE = 'http://127.0.0.1:8787';
const LS_KEY = 'linkagent.gw.base';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  error?: string;
  done?: boolean;
}

let msgSeq = 0;

export function App() {
  const [base, setBase] = useState(() => localStorage.getItem(LS_KEY) ?? DEFAULT_BASE);
  const [client] = useState(() => new GatewayClient(base));
  const [wxClient] = useState(() => new WeixinClient(base));
  const [health, setHealth] = useState<AgentInfo[] | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('agent:pi');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 个人微信扫码登录 ──
  const [wxStatus, setWxStatus] = useState<WeixinStatus | null>(null);
  const [wxErr, setWxErr] = useState<string | null>(null);
  const [wxQrImage, setWxQrImage] = useState<string | null>(null);
  const [wxScanning, setWxScanning] = useState(false);
  const [wxMsg, setWxMsg] = useState<string | null>(null);
  const wxPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    } catch {
      /* models 拉取失败不打断页面 */
    }
  }, [client]);

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

  const applyBase = () => {
    localStorage.setItem(LS_KEY, base);
    window.location.reload();
  };

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

  return (
    <div className="page">
      <header>
        <h1>linkagent 后台</h1>
        <div className="gw-bar">
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            spellCheck={false}
            placeholder="网关地址"
          />
          <button onClick={() => void applyBase()}>切换</button>
          <button className="ghost" onClick={() => void refresh()}>
            刷新
          </button>
          <span className={`dot ${health ? 'ok' : 'bad'}`} />
          <span className="gw-state">{healthErr ?? (health ? `${health.length} agent` : '—')}</span>
        </div>
      </header>

      <main>
        <section className="card">
          <h2>网关 Agents</h2>
          {healthErr ? (
            <p className="err">{healthErr}</p>
          ) : health ? (
            <ul>
              {health.map((a) => (
                <li key={a.id}>
                  <code>{a.id}</code>
                  {a.description ? <span className="desc">{a.description}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </section>

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

        <section className="card">
          <ul className="models">
            {models.map((m) => (
              <li
                key={m.id}
                className={m.id === model ? 'active' : ''}
                onClick={() => setModel(m.id)}
                title={m.description}
              >
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
      </main>
    </div>
  );
}
