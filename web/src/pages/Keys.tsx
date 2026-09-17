import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, Switch, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SearchOutlined } from '@ant-design/icons';
import { OpsClient, type TaskItem, type UserTasks } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { CopyableCode, EmptyHint } from '../components/common';

interface Row {
  u: UserTasks;
  t: TaskItem;
}

export function KeysPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [q, setQ] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await ops.listAllTasks());
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all: Row[] = [];
    (users ?? []).forEach((u) => u.tasks.forEach((t) => all.push({ u, t })));
    const withKey = all.filter((r) => !!r.t.key);
    const kw = q.trim().toLowerCase();
    return kw
      ? withKey.filter((r) => (r.t.key! + r.t.name + r.u.userId).toLowerCase().includes(kw))
      : withKey;
  }, [users, q]);

  const toggle = (r: Row) => {
    setBusyKey(r.t.id);
    ops
      .patchTask(r.u.channel, r.u.userId, r.t.id, { keyEnabled: r.t.keyEnabled === false })
      .then(() => {
        notify.success(r.t.keyEnabled === false ? 'Key 已启用' : 'Key 已停用');
        return load();
      })
      .catch((e) => {
        if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusyKey(null));
  };

  const columns: ColumnsType<Row> = [
    {
      title: 'Key',
      dataIndex: ['t', 'key'],
      key: 'key',
      render: (k: string) => <CopyableCode text={k} truncate title="点击复制完整 Key" />,
    },
    {
      title: '所属用户',
      key: 'user',
      render: (_, r) => (
        <code className="code-cell">
          {r.u.channel}:{r.u.userId}
        </code>
      ),
    },
    {
      title: '任务',
      dataIndex: ['t', 'name'],
      key: 'name',
    },
    {
      title: '状态',
      key: 'enabled',
      width: 110,
      render: (_, r) => {
        const enabled = r.t.keyEnabled !== false;
        return (
          <Tag color={enabled ? 'success' : 'default'} style={{ borderRadius: 999 }}>
            {enabled ? '启用' : '停用'}
          </Tag>
        );
      },
    },
    {
      title: '启用',
      key: 'ops',
      width: 90,
      render: (_, r) => (
        <Switch
          size="small"
          checked={r.t.keyEnabled !== false}
          loading={busyKey === r.t.id}
          onChange={() => toggle(r)}
        />
      ),
    },
  ];

  return (
    <div>
      <p className="page-desc">
        任务 key 随任务自动生成，可直接填入 Chatbox 或任意 OpenAI 客户端的 <code>API Key</code>（
        <code>Bearer &lt;key&gt;</code>）做任务级直连，无需全局静态 token 与 channel/userId/task；
        该凭据只能访问这一个任务且不能切换 agent。停用后该 Key 立即失效。
      </p>
      <Input
        prefix={<SearchOutlined style={{ color: 'rgba(229,233,240,0.35)' }} />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索 Key / 任务 / 用户"
        style={{ marginBottom: 14, maxWidth: 360 }}
        allowClear
      />
      <Table
        rowKey={(r) => r.t.id}
        columns={columns}
        dataSource={rows}
        loading={users === null}
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: <EmptyHint text={q ? '没有匹配的 Key' : '暂无 Key'} /> }}
      />
    </div>
  );
}
