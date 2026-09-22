import { useCallback, useEffect, useMemo, useState, type Key } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CommentOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
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

/** 平铺后的任务行：归属登录用户空间，带当前激活标记 */
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
  isAdmin?: boolean;
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
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [form] = Form.useForm();
  const isAdmin = Boolean(props.isAdmin);
  const remoteNodes = useMemo(() => nodes.filter((n) => n.nodeId !== 'local'), [nodes]);

  const nodeId = Form.useWatch('nodeId', form) as string | undefined;
  const isLocalNode = (id?: string) => !id || id === 'local';
  const agentOptions = useMemo<{ id: string; displayName?: string }[]>(() => {
    if (editing?.task?.id === 'default') return [{ id: 'pi', displayName: 'Pi' }];
    if (!isLocalNode(nodeId)) return nodes.find((n) => n.nodeId === nodeId)?.agents ?? [];
    return localAgents;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, nodes, localAgents, editing]);

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

  const loginSpaces = useMemo(() => (users ?? []).filter((u) => u.channel === 'web'), [users]);
  const showOwnerCol = loginSpaces.length > 1;

  const openCreate = () => {
    const mine = props.username
      ? loginSpaces.find((u) => u.userId === props.username)
      : undefined;
    const space = mine ?? loginSpaces[0];
    const ownerUsername = space?.ownerUsername ?? space?.userId ?? props.username;
    if (!ownerUsername) {
      notify.info('请先登录后再创建任务。');
      return;
    }
    if (!isAdmin && remoteNodes.length === 0) {
      notify.info('普通用户的默认任务固定为本机 pi。新建其它任务请先接入自己的远程机器。');
      return;
    }
    const firstRemote = remoteNodes[0];
    setEditing({ channel: 'web', userId: ownerUsername, ownerUsername });
    form.setFieldsValue({
      name: '',
      agentId: isAdmin ? (localAgents[0]?.id ?? '') : (firstRemote?.agents[0]?.id ?? ''),
      nodeId: isAdmin ? '' : (firstRemote?.nodeId ?? ''),
      key: '',
      cwd: '',
      ownerUsername,
    });
    setOpen(true);
    if (isAdmin) {
      void ops
        .getDefaultAgent()
        .then((id) => form.setFieldValue('agentId', localAgents.some((a) => a.id === id) ? id : localAgents[0]?.id ?? ''))
        .catch(() => undefined);
    }
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
        if (v.agentId !== t.agentId || (v.nodeId ?? '') !== (t.nodeId ?? '')) {
          if (t.id === 'default') {
            notify.info('默认任务固定使用本机 pi，不能修改 agent / 节点。');
          } else {
            await ops.setTaskAgent(editing.channel, editing.userId, t.id, v.agentId, v.nodeId || undefined, editing.ownerUsername);
          }
        }
      }, '任务已保存');
    } else {
      const ownerUsername = (typeof v.ownerUsername === 'string' && v.ownerUsername.trim()) || editing.ownerUsername;
      const userId = ownerUsername || editing.userId;
      await withBusy(
        () =>
          ops.createTask({
            channel: 'web',
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
  const hasDefault = flatTasks.some((t) => t.id === 'default');

  const createDefault = () => {
    const ownerUsername = props.username;
    if (!ownerUsername) {
      notify.info('请先登录后再创建默认任务。');
      return;
    }
    void withBusy(
      () =>
        ops.createTask({
          channel: 'web',
          userId: ownerUsername,
          name: '默认',
          ownerUsername,
          createDefault: true,
        }),
      '已创建默认任务',
    );
  };

  const taskRowKey = (t: FlatTask) => `${t.ownerUsername ?? ''}:${t.channel}:${t.userId}:${t.id}`;

  const selectedTasks = useMemo(
    () => flatTasks.filter((t) => selectedKeys.includes(taskRowKey(t))),
    [flatTasks, selectedKeys],
  );

  const batchDelete = async () => {
    if (selectedTasks.length === 0) return;
    const ok = await confirmAsync({
      title: `删除选中的 ${selectedTasks.length} 个任务？`,
      content: '包含默认任务在内均会删除，对应 Key 同时失效，此操作不可恢复。',
      okText: '批量删除',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    await withBusy(async () => {
      for (const t of selectedTasks) {
        await ops.deleteTask(t.channel, t.userId, t.id, t.ownerUsername);
      }
      setSelectedKeys([]);
    }, `已删除 ${selectedTasks.length} 个任务`);
  };

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
    ...(showOwnerCol
      ? [
          {
            title: '用户',
            key: 'owner',
            render: (_: unknown, t: FlatTask) => <code className="code-cell">{t.ownerUsername || t.userId}</code>,
          } satisfies ColumnsType<FlatTask>[number],
        ]
      : []),
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
              onClick={() => void withBusy(() => ops.activateTask(t.channel, t.userId, t.id, t.ownerUsername), '已设为当前任务')}
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
        任务列表按<strong>登录用户</strong>隔离，不按微信联系人拆分。默认任务固定本机 <code>pi</code>，不能改绑。重新绑定微信会重签本页 Key（<code>k_</code>）。微信里发送 <code>/task</code> 或本页「激活」会切换你的当前任务。
      </p>
      {users === null ? (
        <Table loading showHeader={false} pagination={false} rowKey="x" columns={[{ title: '', dataIndex: 'x' }]} dataSource={[]} />
      ) : (
        <>
          <Space style={{ marginBottom: 12 }} wrap>
            <Tag color="blue" style={{ borderRadius: 999, marginInlineEnd: 0 }}>
              共 {flatTasks.length} 个任务
            </Tag>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建任务
            </Button>
            {!hasDefault ? (
              <Button disabled={busy} onClick={createDefault}>
                创建默认任务
              </Button>
            ) : null}
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={busy || selectedTasks.length === 0}
              onClick={() => void batchDelete()}
            >
              批量删除{selectedTasks.length > 0 ? `（${selectedTasks.length}）` : ''}
            </Button>
          </Space>
          {flatTasks.length === 0 ? (
            <EmptyHint text="还没有任务。可「创建默认任务」（本机 pi），或「新建任务」。微信里发送 /task new default 也会重建默认任务。" />
          ) : (
            <Table
              rowKey={taskRowKey}
              size="small"
              columns={columns}
              dataSource={flatTasks}
              pagination={false}
              rowClassName={(t) => (t.active ? 'task-active-row' : '')}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys),
              }}
            />
          )}
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
          {!editing?.task && showOwnerCol ? (
            <Form.Item name="ownerUsername" label="归属用户" rules={[{ required: true, message: '请选择用户' }]}>
              <Select
                options={loginSpaces.map((u) => ({
                  value: u.ownerUsername || u.userId,
                  label: u.ownerUsername || u.userId,
                }))}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="name" label="任务名" rules={[{ required: true, message: '请输入任务名' }]}>
            <Input placeholder="例如：默认任务" />
          </Form.Item>
          <Form.Item
            name="agentId"
            label="Agent"
            extra={editing?.task?.id === 'default' ? '默认任务固定使用本机 pi，不能修改。' : undefined}
          >
            <Select
              disabled={editing?.task?.id === 'default'}
              options={[
                ...(editing?.task ? [] : [{ value: '', label: '（跟随当前激活任务）' }]),
                ...agentOptions.map((a) => ({ value: a.id, label: a.displayName || a.id })),
              ]}
            />
          </Form.Item>
          <Form.Item name="nodeId" label="运行节点">
            <Select
              disabled={editing?.task?.id === 'default'}
              options={
                editing?.task?.id === 'default'
                  ? [{ value: '', label: '本机' }]
                  : isAdmin
                    ? [{ value: '', label: '本机' }, ...nodes.map((n) => ({ value: n.nodeId, label: n.name }))]
                    : remoteNodes.map((n) => ({ value: n.nodeId, label: n.name }))
              }
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
