import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CommentOutlined, PlusOutlined } from '@ant-design/icons';
import { OpsClient, type NodeInfo, type TaskItem, type UserTasks } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { EmptyHint } from '../components/common';
import type { ChatSession } from './types';

interface EditState {
  channel: string;
  userId: string;
  task?: TaskItem;
}

/** 平铺后的任务行：携带归属（渠道终端）与当前激活标记 */
interface FlatTask extends TaskItem {
  channel: string;
  userId: string;
  active: boolean;
}

export function TasksPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onOpenChat: (session: ChatSession) => void;
}) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [localAgents, setLocalAgents] = useState<{ id: string; displayName?: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const nodeId = Form.useWatch('nodeId', form) as string | undefined;
  const isLocalNode = (id?: string) => !id || id === 'local';
  const agentOptions = useMemo<{ id: string; displayName?: string }[]>(() => {
    if (!isLocalNode(nodeId)) return nodes.find((n) => n.nodeId === nodeId)?.agents ?? [];
    return localAgents;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, nodes, localAgents]);

  const syncAgentForNode = (nextNode?: string) => {
    const list = isLocalNode(nextNode) ? localAgents : nodes.find((n) => n.nodeId === nextNode)?.agents ?? [];
    const cur = form.getFieldValue('agentId') as string | undefined;
    if (!list.some((a) => a.id === cur)) form.setFieldValue('agentId', list[0]?.id ?? '');
  };

  const load = useCallback(async () => {
    try {
      const [u, na] = await Promise.all([ops.listAllTasks(), ops.nodeAgents()]);
      setUsers(u);
      setNodes(na.nodes);
      setLocalAgents(na.local.agents);
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (ok) notify.success(ok);
    } catch (e) {
      if (props.onAuthError(e)) return;
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 最近活跃的渠道终端 = 当前用户归属（users 按活跃倒序，当前部署即自身的微信终端） */
  const currentOwner = users && users.length > 0 ? users[0] : undefined;

  const openCreate = () => {
    const owner = currentOwner;
    if (!owner) return;
    setEditing({ channel: owner.channel, userId: owner.userId });
    form.setFieldsValue({ name: '', agentId: localAgents[0]?.id ?? '', nodeId: '', key: '', cwd: '' });
    setOpen(true);
    void ops
      .getDefaultAgent()
      .then((id) => form.setFieldValue('agentId', localAgents.some((a) => a.id === id) ? id : localAgents[0]?.id ?? ''))
      .catch(() => undefined);
  };

  const openEdit = (t: FlatTask) => {
    setEditing({ channel: t.channel, userId: t.userId, task: t });
    form.setFieldsValue({
      name: t.name,
      agentId: t.agentId,
      nodeId: t.nodeId && t.nodeId !== 'local' ? t.nodeId : '',
      cwd: t.cwd ?? '',
    });
    setOpen(true);
    syncAgentForNode(t.nodeId ?? '');
  };

  const submit = async () => {
    const v = await form.validateFields();
    if (!editing) return;
    if (editing.task) {
      const t = editing.task;
      await withBusy(async () => {
        if (v.name.trim() && v.name.trim() !== t.name) await ops.patchTask(editing.channel, editing.userId, t.id, { name: v.name.trim() });
        if ((v.cwd ?? '').trim() !== (t.cwd ?? ''))
          await ops.patchTask(editing.channel, editing.userId, t.id, { cwd: v.cwd?.trim() || null });
        if (v.agentId !== t.agentId || (v.nodeId ?? '') !== (t.nodeId ?? ''))
          await ops.setTaskAgent(editing.channel, editing.userId, t.id, v.agentId, v.nodeId || undefined);
      }, '任务已保存');
    } else {
      await withBusy(
        () =>
          ops.createTask({
            channel: editing.channel,
            userId: editing.userId,
            name: v.name.trim(),
            ...(v.agentId ? { agentId: v.agentId } : {}),
            ...(v.nodeId ? { nodeId: v.nodeId } : {}),
            ...(v.key?.trim() ? { key: v.key.trim() } : {}),
            ...(v.cwd?.trim() ? { cwd: v.cwd.trim() } : {}),
          }),
        '任务已创建',
      );
    }
    setOpen(false);
  };

  /** 平铺所有任务：不带用户维度，仅保留归属与当前激活标记用于操作 */
  const flatTasks = useMemo<FlatTask[]>(
    () =>
      (users ?? []).flatMap((u) =>
        u.tasks.map((t) => ({
          ...t,
          channel: u.channel,
          userId: u.userId,
          active: u.activeTaskId === t.id,
        })),
      ),
    [users],
  );

  const columns: ColumnsType<FlatTask> = [
    {
      title: '任务名',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, t) => (
        <Space size={8}>
          {t.active ? <Tag color="success" style={{ borderRadius: 999 }}>当前</Tag> : null}
          <span style={{ fontWeight: t.active ? 600 : 400 }}>{name}</span>
        </Space>
      ),
    },
    {
      title: 'Key',
      dataIndex: 'key',
      key: 'key',
      responsive: ['md'],
      render: (k?: string) => (k ? <code className="code-cell">{k.slice(0, 10)}…</code> : <span className="sub-muted">—</span>),
    },
    {
      title: 'Agent',
      dataIndex: 'agentId',
      key: 'agentId',
      render: (v: string) => <code className="code-cell">{v}</code>,
    },
    {
      title: '节点',
      dataIndex: 'nodeId',
      key: 'nodeId',
      responsive: ['lg'],
      render: (v?: string) => v || <span className="sub-muted">本机</span>,
    },
    {
      title: 'cwd',
      dataIndex: 'cwd',
      key: 'cwd',
      responsive: ['xl'],
      render: (v?: string) => <span className="sub-muted">{v || '—'}</span>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 268,
      render: (_, t) => (
        <Space size={6}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<CommentOutlined />}
            onClick={() =>
              props.onOpenChat({
                channel: t.channel,
                userId: t.userId,
                taskId: t.id,
                taskName: t.name,
                agentId: t.agentId,
                nodeId: t.nodeId,
                key: t.key,
                keyEnabled: t.keyEnabled,
              })
            }
          >
            对话
          </Button>
          {!t.active ? (
            <Button size="small" disabled={busy} onClick={() => void withBusy(() => ops.activateTask(t.channel, t.userId, t.id), '已激活任务')}>
              激活
            </Button>
          ) : null}
          <Button size="small" onClick={() => openEdit(t)}>
            编辑
          </Button>
          <Button
            size="small"
            danger
            disabled={busy}
            onClick={async () => {
              const ok = await confirmAsync({
                title: `删除任务「${t.name}」？`,
                content: '该任务的 Key 将同时失效，此操作不可恢复。',
                okText: '删除',
                okButtonProps: { danger: true },
              });
              if (ok) await withBusy(() => ops.deleteTask(t.channel, t.userId, t.id), '任务已删除');
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {err ? <Tag color="error" style={{ fontSize: 13, padding: '4px 10px', marginBottom: 12 }}>{err}</Tag> : null}
      <p className="page-desc" style={{ marginBottom: 12 }}>
        这里列出当前用户（admin）的全部多轮会话任务，用于会话隔离与路由。终端在首次发起渠道消息时自动建档；
        点「对话」进入该任务的持久会话页。Chatbox 等 OpenAI 客户端用任务 Key / Token 直连，不在这里产生终端。
      </p>
      {users === null ? (
        <Table loading showHeader={false} pagination={false} rowKey="x" columns={[{ title: '', dataIndex: 'x' }]} dataSource={[]} />
      ) : users.length === 0 ? (
        <EmptyHint text="暂无任务（微信终端首次发消息后自动创建）" />
      ) : (
        <>
          <Space style={{ marginBottom: 12 }} wrap>
            <Tag color="blue" style={{ borderRadius: 999, marginInlineEnd: 0 }}>
              共 {flatTasks.length} 个任务
            </Tag>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建任务
            </Button>
          </Space>
          <Table
            rowKey={(t) => `${t.channel}:${t.userId}:${t.id}`}
            size="small"
            columns={columns}
            dataSource={flatTasks}
            pagination={false}
            rowClassName={(t) => (t.active ? 'task-active-row' : '')}
          />
        </>
      )}

      <Modal
        title={editing?.task ? `编辑任务 · ${editing.task.name}` : '新建任务'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        confirmLoading={busy}
        okText={editing?.task ? '保存' : '创建'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="任务名" rules={[{ required: true, message: '请输入任务名' }]}>
            <Input placeholder="例如：默认任务" />
          </Form.Item>
          <Form.Item name="agentId" label="Agent">
            <Select
              options={[
                ...(editing?.task ? [] : [{ value: '', label: '（跟随当前激活任务）' }]),
                ...agentOptions.map((a) => ({ value: a.id, label: a.displayName || a.id })),
              ]}
            />
          </Form.Item>
          <Form.Item name="nodeId" label="运行节点">
            <Select
              options={[{ value: '', label: '本机' }, ...nodes.map((n) => ({ value: n.nodeId, label: n.name }))]}
              onChange={(v: string) => syncAgentForNode(v)}
            />
          </Form.Item>
          {!editing?.task ? (
            <Form.Item name="key" label="Key（留空自动生成）">
              <Input autoComplete="off" />
            </Form.Item>
          ) : null}
          <Form.Item name="cwd" label="工作目录 cwd">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
