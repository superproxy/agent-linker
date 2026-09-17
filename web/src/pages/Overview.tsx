import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Col, Input, Row, Select, Tag, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  KeyOutlined,
  MessageOutlined,
  SendOutlined,
  StopOutlined,
  WechatOutlined,
} from '@ant-design/icons';
import {
  AdminClient,
  GatewayClient,
  OpsClient,
  WeixinClient,
  type AgentDetail,
  type ChatDelta,
  type ModelInfo,
  type NodeInfo,
  type UserTasks,
  type WeixinStatus,
} from '../api';
import { useRefreshTick } from '../lib/hooks';
import { StatCard } from '../components/common';
import type { PageProps } from './types';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  error?: string;
  done?: boolean;
}

let msgSeq = 0;

export function Overview(props: PageProps) {
  const { base, token, onAuthError } = props;
  const client = useMemo(() => new GatewayClient(base, () => token), [base, token]);
  const admin = useMemo(() => new AdminClient(base, token), [base, token]);
  const ops = useMemo(() => new OpsClient(base, () => token), [base, token]);
  const wx = useMemo(() => new WeixinClient(base, () => token), [base, token]);
  const { tick } = useRefreshTick();

  const [agents, setAgents] = useState<AgentDetail[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [wxStatus, setWxStatus] = useState<WeixinStatus | null>(null);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('agent:pi');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadStats = useCallback(async () => {
    const [aRes, nRes, tRes, wRes] = await Promise.allSettled([
      admin.listAgents().then(async (list) => ({ list, def: await admin.getDefaultAgent() })),
      ops.listNodes(),
      ops.listAllTasks(),
      wx.status(),
    ]);
    if (aRes.status === 'fulfilled') {
      setAgents(aRes.value.list);
      setDefaultAgentId(aRes.value.def);
    } else if (onAuthError(aRes.reason)) return;
    if (nRes.status === 'fulfilled') setNodes(nRes.value);
    else onAuthError(nRes.reason);
    if (tRes.status === 'fulfilled') setUsers(tRes.value);
    else onAuthError(tRes.reason);
    if (wRes.status === 'fulfilled') setWxStatus(wRes.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, ops, wx, tick]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    let alive = true;
    client
      .models()
      .then((m) => alive && setModels(m))
      .catch((e) => !onAuthError(e) && undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const enabledAgents = (agents ?? []).filter((a) => a.enabled).length;
  const onlineNodes = (nodes ?? []).filter((n) => n.status !== 'pending' && n.status !== 'blocked' && n.online).length;
  const pendingNodes = (nodes ?? []).filter((n) => n.status === 'pending').length;
  const taskCount = (users ?? []).reduce((s, u) => s + u.tasks.length, 0);
  const keyCount = (users ?? []).reduce((s, u) => s + u.tasks.filter((t) => t.key).length, 0);

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
        if (onAuthError(e)) return;
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

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<AppstoreOutlined />}
            iconBg="rgba(59,130,246,0.14)"
            iconColor="#60a5fa"
            label="启用 Agent"
            value={agents ? enabledAgents : '—'}
            unit={agents ? `/ ${agents.length}` : ''}
            foot={defaultAgentId ? <>默认 <code className="mono">{defaultAgentId}</code></> : '加载中'}
            loading={!agents}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<ClusterOutlined />}
            iconBg="rgba(34,197,94,0.14)"
            iconColor="#4ade80"
            label="在线节点"
            value={nodes ? onlineNodes : '—'}
            unit="个"
            foot={pendingNodes > 0 ? <Tag color="warning" style={{ borderRadius: 999 }}>{pendingNodes} 待审批</Tag> : '本机始终可用'}
            loading={!nodes}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<MessageOutlined />}
            iconBg="rgba(168,85,247,0.14)"
            iconColor="#c084fc"
            label="任务总数"
            value={users ? taskCount : '—'}
            unit="个"
            foot={`${users ? users.length : 0} 个渠道用户`}
            loading={!users}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<KeyOutlined />}
            iconBg="rgba(234,179,8,0.14)"
            iconColor="#facc15"
            label="活跃 Key"
            value={users ? keyCount : '—'}
            unit="枚"
            foot="任务级直连凭据"
            loading={!users}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<WechatOutlined />}
            iconBg={wxStatus?.configured ? 'rgba(34,197,94,0.14)' : 'rgba(148,163,184,0.14)'}
            iconColor={wxStatus?.configured ? '#4ade80' : '#94a3b8'}
            label="微信渠道"
            value={wxStatus ? (wxStatus.configured ? '已绑定' : '未绑定') : '—'}
            foot={wxStatus?.activeAccountId ? `账号 ${wxStatus.activeAccountId}` : '可在微信登录页绑定'}
            loading={!wxStatus}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<CheckCircleOutlined />}
            iconBg="rgba(59,130,246,0.14)"
            iconColor="#60a5fa"
            label="可用模型"
            value={models.length || '—'}
            unit={models.length ? '个' : ''}
            foot="OpenAI 兼容接口"
            loading={models.length === 0}
          />
        </Col>
      </Row>

      <Card
        className="chat-card section-gap"
        bordered
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>聊天测试台</span>
            <Tag color="blue" style={{ borderRadius: 999 }}>流式</Tag>
          </div>
        }
        extra={
          <Select
            value={model}
            onChange={setModel}
            style={{ width: 220 }}
            options={models.map((m) => ({ value: m.id, label: m.id }))}
            showSearch
            optionFilterProp="label"
          />
        }
      >
        <div className="chat-thread">
          {messages.length === 0 ? (
            <div className="chat-empty">向网关发送一条消息，测试流式回复（思考流与正文分开展示）</div>
          ) : null}
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role}`}>
              <div className="who">{m.role === 'user' ? '你' : 'agent'}</div>
              {m.reasoning ? (
                <div className="reasoning">
                  <div className="reasoning-title">思考过程</div>
                  {m.reasoning}
                </div>
              ) : null}
              {m.content ? <div className="bubble-body">{m.content}</div> : null}
              {m.error ? (
                <Tag color="error" style={{ alignSelf: 'flex-start' }}>
                  {m.error}
                </Tag>
              ) : null}
              {!m.content && !m.error && !m.done ? (
                <div className="bubble-body">
                  <span className="chat-typing">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              ) : null}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void send()}
            placeholder="输入消息，Enter 发送"
            disabled={busy}
            size="large"
          />
          {busy ? (
            <Button danger size="large" icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>
              停止
            </Button>
          ) : (
            <Tooltip title="发送">
              <Button type="primary" size="large" icon={<SendOutlined />} disabled={!input.trim()} onClick={() => void send()} />
            </Tooltip>
          )}
        </div>
      </Card>
    </div>
  );
}
