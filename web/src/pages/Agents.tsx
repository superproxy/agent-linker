import { useCallback, useEffect, useState } from 'react';
import { Button, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { StarFilled } from '@ant-design/icons';
import { AdminClient, type AgentDetail } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { EmptyHint } from '../components/common';

const { Text } = Typography;

export function AgentsPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const admin = new AdminClient(props.base, props.token);
  const { tick } = useRefreshTick();
  const [agents, setAgents] = useState<AgentDetail[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, def] = await Promise.all([admin.listAgents(), admin.getDefaultAgent()]);
      setAgents(list);
      setDefaultAgentId(def);
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.base, props.token, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(id);
    try {
      await fn();
      notify.success(ok);
      await load();
    } catch (e) {
      if (props.onAuthError(e)) return;
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<AgentDetail> = [
    {
      title: 'Agent',
      dataIndex: 'id',
      key: 'id',
      render: (_, a) => (
        <Space size={8}>
          {a.id === defaultAgentId ? <StarFilled style={{ color: '#facc15' }} /> : null}
          <Text code style={{ fontSize: 12.5 }}>{a.id}</Text>
          {a.displayName && a.displayName !== a.id ? <Text strong>{a.displayName}</Text> : null}
        </Space>
      ),
    },
    {
      title: '说明',
      dataIndex: 'description',
      key: 'description',
      responsive: ['md'],
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12.5 }}>{v || '—'}</Text>,
    },
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model',
      responsive: ['lg'],
      render: (v?: string) => (v ? <Text code style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">agent 默认</Text>),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'success' : 'default'} style={{ borderRadius: 999 }}>
          {enabled ? '启用' : '停用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 180,
      render: (_, a) => (
        <Space size={6}>
          <Tooltip title={a.id === defaultAgentId ? '已是默认 agent' : '设为新任务的默认 agent'}>
            <Button
              size="small"
              disabled={a.id === defaultAgentId || busyId === a.id}
              onClick={() => void run(a.id, () => admin.setDefaultAgent(a.id), `已设置默认 agent：${a.id}`)}
            >
              设为默认
            </Button>
          </Tooltip>
          <Button
            size="small"
            type={a.enabled ? 'default' : 'primary'}
            ghost={!a.enabled}
            danger={a.enabled}
            disabled={busyId === a.id}
            onClick={() =>
              void run(
                a.id,
                () => admin.patchAgent(a.id, { enabled: !a.enabled }),
                `已${a.enabled ? '停用' : '启用'}：${a.id}`,
              )
            }
          >
            {a.enabled ? '停用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {err ? (
        <div style={{ marginBottom: 12 }}>
          <Tag color="error" style={{ fontSize: 13, padding: '4px 10px' }}>{err}</Tag>
        </div>
      ) : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={agents ?? []}
        loading={agents === null}
        pagination={false}
        size="middle"
        locale={{ emptyText: <EmptyHint text="暂无 agent，请检查网关配置" /> }}
        rowClassName={(a) => (a.id === defaultAgentId ? 'agent-default-row' : '')}
      />
      <p className="page-desc" style={{ marginTop: 12 }}>
        启停与切换为运行时热更新（立即生效，重启网关后还原 config.yaml）；「设为默认」会持久化到 config.yaml。
      </p>
    </div>
  );
}
