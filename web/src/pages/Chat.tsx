import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Empty, Flex, Input, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ClearOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import { GatewayClient, OpsClient, type ChatDelta, type ModelInfo, type NodeInfo } from '../api';
import { useRefreshTick } from '../lib/hooks';
import type { ChatSession, PageProps } from './types';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  error?: string;
  done?: boolean;
}

let msgSeq = 0;

function sessionFingerprint(s: ChatSession | null): string {
  if (!s) return 'oneshot';
  return `${s.channel}:${s.userId}:${s.taskId}`;
}

export function ChatPage(
  props: PageProps & { session: ChatSession | null; onClearSession: () => void },
) {
  const { base, token, onAuthError, session, onClearSession } = props;
  const client = useMemo(() => new GatewayClient(base, () => token), [base, token]);
  const ops = useMemo(() => new OpsClient(base, () => token), [base, token]);
  const { tick } = useRefreshTick();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [model, setModel] = useState('agent:pi');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fp = sessionFingerprint(session);

  useEffect(() => {
    let alive = true;
    client
      .models()
      .then((m) => {
        if (!alive) return;
        setModels(m);
        if (m.length && !m.some((x) => x.id === model)) {
          const first = m[0];
          if (first) setModel(first.id);
        }
      })
      .catch((e) => {
        if (!onAuthError(e)) return;
      });
    ops
      .listNodes()
      .then((n) => alive && setNodes(n))
      .catch((e) => onAuthError(e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ops, tick]);

  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setBusy(false);
    if (session) setModel(`agent:${session.agentId}`);
  }, [fp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const nodeId = session?.nodeId && session.nodeId !== 'local' ? session.nodeId : 'local';
  const nodeOnline =
    nodeId === 'local' || nodes.some((n) => n.nodeId === nodeId && n.online && n.status !== 'blocked');
  const useTaskKey = Boolean(session?.key && session.keyEnabled !== false);
  const lockedModel = session ? `agent:${session.agentId}` : model;

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (session && !nodeOnline) return;
    const userMsg: Msg = { id: ++msgSeq, role: 'user', content: text };
    const asstMsg: Msg = { id: ++msgSeq, role: 'assistant', content: '' };
    const history: Msg[] = [...messages, userMsg];
    setMessages([...history, asstMsg]);
    setInput('');
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;

    let content = '';
    let reasoning = '';
    try {
      const streamOpts = session
        ? useTaskKey
          ? { signal: abort.signal, taskKey: session.key, agent: session.agentId }
          : {
              signal: abort.signal,
              channel: session.channel,
              userId: session.userId,
              task: session.taskId,
              agent: session.agentId,
            }
        : { signal: abort.signal };
      for await (const d of client.streamChat(
        lockedModel,
        history.map((m) => ({ role: m.role, content: m.content })),
        streamOpts,
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
        const last = idx >= 0 ? prev[idx] : undefined;
        if (!last || last.id !== asstMsg.id) return prev;
        const next = [...prev];
        next[idx] = fn(last);
        return next;
      });
    }
  };

  const title = session ? (
    <Flex align="center" gap={8} wrap="wrap">
      <Typography.Text strong>任务对话</Typography.Text>
      <Tag color="blue" style={{ borderRadius: 999 }}>
        {session.taskName}
      </Tag>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {session.channel}/{session.userId}
      </Typography.Text>
      <Tag style={{ borderRadius: 999 }}>{session.agentId}</Tag>
      <Tag color={nodeOnline ? 'success' : 'error'} style={{ borderRadius: 999 }}>
        {nodeId === 'local' ? '本机' : nodeId}
        {nodeOnline ? '' : ' · 离线'}
      </Tag>
      <Tag style={{ borderRadius: 999 }}>{useTaskKey ? 'key 直连' : '三元素路由'}</Tag>
    </Flex>
  ) : (
    <Flex align="center" gap={8}>
      <Typography.Text strong>对话测试</Typography.Text>
      <Tag color="blue" style={{ borderRadius: 999 }}>
        流式 · oneshot
      </Tag>
    </Flex>
  );

  return (
    <Flex vertical className="chat-page" gap={12}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        {session
          ? '当前进入该任务的持久会话（有记忆）。消息走网关 /v1 任务路由，与微信渠道同一套任务隔离。'
          : '未绑定任务时为 oneshot 测试。从「任务管理」点「对话」可进入对应任务的持久会话。'}
      </Typography.Paragraph>
      <Card
        className="chat-card"
        bordered
        title={title}
        extra={
          <Space size={8} wrap>
            {session ? (
              <Button size="small" onClick={onClearSession}>
                退出任务会话
              </Button>
            ) : (
              <Select
                value={model}
                onChange={setModel}
                style={{ width: 220 }}
                options={models.map((m) => ({ value: m.id, label: m.id }))}
                showSearch
                optionFilterProp="label"
              />
            )}
            <Tooltip title="清空当前气泡（服务端会话不受影响）">
              <Button size="small" icon={<ClearOutlined />} disabled={busy} onClick={() => setMessages([])} />
            </Tooltip>
          </Space>
        }
        styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <Flex vertical flex={1} style={{ minHeight: 0, gap: 12 }}>
          <Flex vertical flex={1} style={{ minHeight: 280, overflowY: 'auto', gap: 14, padding: '4px 2px' }}>
            {messages.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  session
                    ? `已进入任务「${session.taskName}」，发送消息开始多轮对话`
                    : '向网关发送一条消息，测试流式回复（思考流与正文分开展示）'
                }
              />
            ) : null}
            {messages.map((m) => (
              <Flex key={m.id} vertical align={m.role === 'user' ? 'flex-end' : 'flex-start'} style={{ maxWidth: '92%', alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <Typography.Text type="secondary" style={{ fontSize: 11, padding: '0 2px' }}>
                  {m.role === 'user' ? '你' : session ? `task:${session.taskName}` : 'agent'}
                </Typography.Text>
                {m.reasoning ? (
                  <Card size="small" style={{ width: '100%', marginTop: 4, background: 'rgba(234,179,8,0.06)', borderColor: 'rgba(234,179,8,0.28)' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                      思考过程
                    </Typography.Text>
                    <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#d8c07a' }}>
                      {m.reasoning}
                    </Typography.Paragraph>
                  </Card>
                ) : null}
                {m.content ? (
                  <Card
                    size="small"
                    style={{
                      marginTop: 4,
                      background: m.role === 'user' ? 'linear-gradient(135deg, #2563eb, #3b6fe0)' : '#161a22',
                      borderColor: m.role === 'user' ? 'transparent' : '#222a37',
                    }}
                    styles={{ body: { padding: '10px 14px' } }}
                  >
                    <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap', color: m.role === 'user' ? '#f6f9ff' : undefined }}>
                      {m.content}
                    </Typography.Paragraph>
                  </Card>
                ) : null}
                {m.error ? (
                  <Tag color="error" style={{ marginTop: 6 }}>
                    {m.error}
                  </Tag>
                ) : null}
                {!m.content && !m.error && !m.done ? <Spin size="small" style={{ marginTop: 8 }} /> : null}
              </Flex>
            ))}
            <div ref={bottomRef} />
          </Flex>

          {session && !nodeOnline ? (
            <Typography.Text type="danger">节点离线，任务暂不可用。请等待节点重连后再发送。</Typography.Text>
          ) : null}

          <Flex gap={10} align="flex-end">
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={session ? '输入消息，Enter 发送，Shift+Enter 换行' : '输入消息，Enter 发送'}
              disabled={busy || Boolean(session && !nodeOnline)}
              autoSize={{ minRows: 1, maxRows: 6 }}
              size="large"
            />
            {busy ? (
              <Button danger size="large" icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>
                停止
              </Button>
            ) : (
              <Tooltip title="发送">
                <Button
                  type="primary"
                  size="large"
                  icon={<SendOutlined />}
                  disabled={!input.trim() || Boolean(session && !nodeOnline)}
                  onClick={() => void send()}
                />
              </Tooltip>
            )}
          </Flex>
        </Flex>
      </Card>
    </Flex>
  );
}
