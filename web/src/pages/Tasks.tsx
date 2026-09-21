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
  ownerUsername?: string;
  task?: TaskItem;
}

/** 平铺后的任务行：携带归属（渠道终端）与当前激活标记 */
interface FlatTask extends TaskItem {
  channel: string;
  userId: string;
  ownerUsername?: string;
  active: boolean;
}

export function TasksPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onOpenChat: (session: ChatSession) => void;
  username?: string;
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
      setLocalAgents(na.local?.agents ?? []);
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

  /** 新建任务挂到微信连接器已建档的联系人上（与 /task 命令同一份状态） */
  const weixinTerminals = useMemo(() => (users ?? []).filter((u) => u.channel === 'weixin'), [users]);

  const openCreate = () => {
    const owner = weixinTerminals[0];
    if (!owner) {
      notify.info('微信连接器尚未为任何联系人建档。请先在微信里发一条消息，或发送 /task new。');
      return;
    }
    setEditing({ channel: owner.channel, userId: owner.userId, ownerUsername: owner.ownerUsername ?? props.username });
    form.setFieldsValue({
      name: '',
      agentId: localAgents[0]?.id ?? '',
      nodeId: '',
      key: '',
      cwd: '',
      terminal: `${owner.channel}::${owner.userId}::${owner.ownerUsername ?? ''}`,
    });
    setOpen(true);
    void ops
      .getDefaultAgent()
      .then((id) => form.setFieldValue('agentId', localAgents.some((a) => a.id === id) ? id : localAgents[0]?.id ?? ''))
      .catch(() => undefined);
  };

  const openEdit = (t: FlatTask) => {
    setEditing({ channel: t.channel, userId: t.userId, ownerUsername: t.ownerUsername, task: t });
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
        if (v.name.trim() && v.name.trim() !== t.name)
          await ops.patchTask(editing.channel, editing.userId, t.id, { name: v.name.trim() }, editing.ownerUsername);
        if ((v.cwd ?? '').trim() !== (t.cwd ?? ''))
          await ops.patchTask(editing.channel, editing.userId, t.id, { cwd: v.cwd?.trim() || null }, editing.ownerUsername);
        if (v.agentId !== t.agentId || (v.nodeId ?? '') !== (t.nodeId ?? ''))
          await ops.setTaskAgent(editing.channel, editing.userId, t.id, v.agentId, v.nodeId || undefined, editing.ownerUsername);
      }, '任务已保存');
    } else {
      const raw = typeof v.terminal === 'string' ? v.terminal : '';
      const [ch, uid, own] = raw.split('::');
      const channel = ch || editing.channel;
      const userId = uid || editing.userId;
      const ownerUsername = own || editing.ownerUsername;
      await withBusy(
        () =>
          ops.createTask({
            channel,
            userId,
            name: v.name.trim(),
            ...(v.agentId ? { agentId: v.agentId } : {}),
            ...(v.nodeId ? { nodeId: v.nodeId } : {}),
            ...(v.key?.trim() ? { key: v.key.trim() } : {}),
            ...(v.cwd?.trim() ? { cwd: v.cwd.trim() } : {}),
            ...(ownerUsername ? { ownerUsername } : {}),
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
          ownerUsername: u.ownerUsername,
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
      title: '微信终端',
      key: 'peer',
      render: (_, t) => (
        <Space size={6}>
          <Tag color={t.channel === 'weixin' ? 'green' : 'default'} style={{ borderRadius: 999, marginInlineEnd: 0 }}>
            {t.channel === 'weixin' ? '微信' : t.channel}
          </Tag>
          <code className="code-cell">{t.userId}</code>
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
                ownerUsername: t.ownerUsername,
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
            <Button
              size="small"
              disabled={busy}
              onClick={() => void withBusy(() => ops.activateTask(t.channel, t.userId, t.id, t.ownerUsername), '已设为该微信终端的当前任务')}
            >
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
              if (ok) await withBusy(() => ops.deleteTask(t.channel, t.userId, t.id, t.ownerUsername), '任务已删除');
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
        每个微信联系人有自己的任务列表；<strong>当前任务由微信连接器切换</strong>
        （微信里发送 <code>/task</code>，或本页「激活」）。连接器最多约 2 秒内按新激活任务路由。
        点「对话」进入该任务的持久会话。Chatbox 等客户端用任务 Key 直连，不在这里产生终端。
      </p>
      {users === null ? (
        <Table loading showHeader={false} pagination={false} rowKey="x" columns={[{ title: '', dataIndex: 'x' }]} dataSource={[]} />
      ) : users.length === 0 ? (
        <EmptyHint text="暂无微信终端任务。请先绑定微信，在对话里发一条消息或发送 /task new，连接器会自动建档。" />
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
            rowKey={(t) => `${t.ownerUsername ?? ''}:${t.channel}:${t.userId}:${t.id}`}
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
          {!editing?.task && weixinTerminals.length > 0 ? (
            <Form.Item name="terminal" label="微信终端" rules={[{ required: true, message: '请选择联系人' }]}>
              <Select
                options={weixinTerminals.map((u) => ({
                  value: `${u.channel}::${u.userId}::${u.ownerUsername ?? ''}`,
                  label: `微信 · ${u.userId}`,
                }))}
              />
            </Form.Item>
          ) : null}
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
