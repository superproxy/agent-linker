import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { UserAdminClient, type UserPublic } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { EmptyHint } from '../components/common';

export function AccountsPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const client = useMemo(() => new UserAdminClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [users, setUsers] = useState<UserPublic[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserPublic | null>(null);
  const [createForm] = Form.useForm();
  const [resetForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setUsers(await client.list());
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async () => {
    const v = await createForm.validateFields();
    setBusyUser('__new__');
    try {
      await client.create({
        username: v.username.trim(),
        password: v.password,
        role: v.role,
        ...(v.displayName?.trim() ? { displayName: v.displayName.trim() } : {}),
      });
      notify.success(`已创建用户：${v.username.trim()}。用该账号登录后到「微信登录」扫码，才会在 channels 进程启用微信。`);
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  const removeUser = async (u: UserPublic) => {
    const ok = await confirmAsync({
      title: `确认删除用户 ${u.username}？`,
      content: '该用户的登录会话将同时失效。',
      okText: '删除',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    setBusyUser(u.username);
    try {
      await client.remove(u.username);
      notify.success(`已删除用户：${u.username}`);
      await load();
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    const v = await resetForm.validateFields();
    setBusyUser(resetTarget.username);
    try {
      await client.resetPassword(resetTarget.username, v.password);
      notify.success(`已重置 ${resetTarget.username} 的密码（下次登录需改密）`);
      setResetTarget(null);
      resetForm.resetFields();
      await load();
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyUser(null);
    }
  };

  const columns: ColumnsType<UserPublic> = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (v: string) => <code className="code-cell" style={{ fontSize: 13 }}>{v}</code>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 110,
      render: (r: UserPublic['role']) => (
        <Tag color={r === 'admin' ? 'blue' : 'default'} style={{ borderRadius: 999 }}>
          {r === 'admin' ? '管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '显示名',
      dataIndex: 'displayName',
      key: 'displayName',
      responsive: ['md'],
      render: (v?: string) => v || <span className="sub-muted">—</span>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      responsive: ['lg'],
      render: (v: string) => <span className="sub-muted">{dayjs(v).format('YYYY-MM-DD HH:mm')}</span>,
    },
    {
      title: '状态',
      dataIndex: 'mustChangePassword',
      key: 'mustChangePassword',
      width: 110,
      render: (m: boolean) =>
        m ? (
          <Tag color="warning" style={{ borderRadius: 999 }}>
            待改密
          </Tag>
        ) : (
          <Tag color="success" style={{ borderRadius: 999 }}>
            正常
          </Tag>
        ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 180,
      render: (_, u) => (
        <Space size={6}>
          <Button
            size="small"
            disabled={busyUser === u.username}
            onClick={() => {
              setResetTarget(u);
              resetForm.resetFields();
            }}
          >
            重置密码
          </Button>
          <Button size="small" danger disabled={busyUser === u.username} onClick={() => void removeUser(u)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {err ? <Tag color="error" style={{ fontSize: 13, padding: '4px 10px', marginBottom: 12 }}>{err}</Tag> : null}
      <p className="page-desc" style={{ marginBottom: 14 }}>
        管理可登录后台的<strong>系统账号</strong>（admin / user）；个人 API 见侧栏「我的 · 用户 Key（pat_）」。
        新建账号后，请用该用户登录，在「我的 · 微信」扫码绑定，才会在 <code>channels</code> 进程内启用该账号。
        微信聊天对象的 <code>ct_</code> 由管理员在「我的 · 用户 Key → 微信终端」管理。
      </p>
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新增用户
        </Button>
      </div>
      <Table
        rowKey="username"
        columns={columns}
        dataSource={users ?? []}
        loading={users === null}
        pagination={false}
        locale={{ emptyText: <EmptyHint text="暂无用户" /> }}
      />

      <Modal
        title="新增用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        confirmLoading={busyUser === '__new__'}
        okText="创建"
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }} initialValues={{ role: 'user' }}>
          <Form.Item name="username" label="用户名" rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[A-Za-z0-9._-]+$/, message: '仅支持字母数字及 . _ -' },
          ]}>
            <Input placeholder="字母数字 . _ -" spellCheck={false} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[
            { required: true, message: '请输入初始密码' },
            { min: 8, message: '至少 8 位' },
          ]}>
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选）">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select
              options={[
                { value: 'user', label: '普通用户' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`重置密码 · ${resetTarget?.username ?? ''}`}
        open={!!resetTarget}
        onCancel={() => setResetTarget(null)}
        onOk={() => void submitReset()}
        confirmLoading={!!resetTarget && busyUser === resetTarget.username}
        okText="确认重置"
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="password" label="新密码" rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '至少 8 位' },
          ]}>
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
