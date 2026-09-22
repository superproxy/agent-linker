import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import { OpsClient, type NodeInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { EmptyHint, StateTag } from '../components/common';
import { relTime, type TabId } from '../lib/constants';
import { NodeEnrollPanel } from './NodeEnroll';

export function NodesPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  scope: 'local' | 'remote';
  isAdmin?: boolean;
  onGoTab?: (tab: TabId) => void;
}) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);

  const load = useCallback(async () => {
    try {
      setNodes(await ops.listNodes());
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, tick]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const guard = (id: string) => (action: Promise<unknown>) => {
    setBusyId(id);
    action
      .then(() => {
        notify.success('操作成功');
        return load();
      })
      .catch((e) => {
        if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusyId(null));
  };

  const pending = (nodes ?? []).filter((n) => n.status === 'pending');
  const visible = (nodes ?? []).filter((n) => (props.scope === 'local' ? n.nodeId === 'local' : n.nodeId !== 'local'));
  const isRemote = props.scope === 'remote';

  const columns: ColumnsType<NodeInfo> = [
    {
      title: '节点名称',
      key: 'name',
      render: (_, n) => <code className="code-cell" style={{ fontSize: 13 }}>{n.name}</code>,
    },
    {
      title: '节点 ID',
      dataIndex: 'nodeId',
      key: 'nodeId',
      width: 180,
      render: (v: string) => <code className="code-cell">{v}</code>,
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_, n) => {
        if (n.disabled) return <StateTag state="disabled" />;
        if (n.status === 'pending') return <StateTag state="pending" />;
        if (n.status === 'blocked') return <StateTag state="blocked" />;
        return <StateTag state={n.online ? 'on' : 'off'} />;
      },
    },
    {
      title: '属主',
      key: 'owner',
      width: 110,
      responsive: ['lg'],
      render: (_, n) =>
        n.nodeId === 'local' ? (
          <span className="sub-muted">本机</span>
        ) : n.ownerUsername ? (
          <code className="code-cell">{n.ownerUsername}</code>
        ) : (
          <span className="sub-muted">—</span>
        ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      responsive: ['md'],
      render: (v?: string) => v || <span className="sub-muted">—</span>,
    },
    {
      title: 'Agents',
      dataIndex: 'agents',
      key: 'agents',
      responsive: ['lg'],
      render: (a: NodeInfo['agents']) =>
        a.length ? (
          <Space size={4} wrap>
            {a.map((x) => (
              <Tag key={x.id} style={{ borderRadius: 6 }}>{x.id}</Tag>
            ))}
          </Space>
        ) : (
          <span className="sub-muted">—</span>
        ),
    },
    {
      title: '最近连接',
      key: 'seen',
      responsive: ['md'],
      render: (_, n) =>
        relTime(n.online || n.status === 'pending' ? (n.connectedAt ?? n.lastSeenAt ?? 0) : (n.lastSeenAt ?? 0)),
    },
    {
      title: '操作',
      key: 'ops',
      width: 280,
      render: (_, n) => {
        const isLocal = n.nodeId === 'local';
        const isPending = n.status === 'pending';
        if (isLocal) return <span className="sub-muted">内建</span>;
        if (isPending)
          return (
            <Space size={6}>
              <Button size="small" type="primary" disabled={busyId === n.nodeId} onClick={() => guard(n.nodeId)(ops.approveNode(n.nodeId))}>
                批准
              </Button>
              <Popconfirm
                title={`拒绝节点「${n.name}」接入？`}
                description="拒绝后其连接会被断开且无法重连（删除记录后可重新申请）。"
                okText="拒绝"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => guard(n.nodeId)(ops.rejectNode(n.nodeId))}
              >
                <Button size="small" danger disabled={busyId === n.nodeId}>
                  拒绝
                </Button>
              </Popconfirm>
              <Button size="small" disabled={busyId === n.nodeId} onClick={() => guard(n.nodeId)(ops.deleteNode(n.nodeId))}>
                删除
              </Button>
            </Space>
          );
        if (n.disabled) {
          return (
            <Space size={6}>
              <Button
                size="small"
                type="primary"
                disabled={busyId === n.nodeId}
                onClick={() => guard(n.nodeId)(ops.enableNode(n.nodeId))}
              >
                启用
              </Button>
              <Popconfirm
                title={`删除节点「${n.name}」的注册信息？`}
                description="删除后该节点需重新走接入流程。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => guard(n.nodeId)(ops.deleteNode(n.nodeId))}
              >
                <Button size="small" danger disabled={busyId === n.nodeId}>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          );
        }
        return (
          <Space size={6}>
            <Popconfirm
              title={`停用节点「${n.name}」？`}
              description="节点将被断开连接，路由层忽略；后续重连会被拒。管理员可重新启用。"
              okText="停用"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => guard(n.nodeId)(ops.disableNode(n.nodeId))}
            >
              <Button size="small" disabled={busyId === n.nodeId}>
                禁用
              </Button>
            </Popconfirm>
            <Popconfirm
              title={`删除节点「${n.name}」的注册信息？`}
              description="在线节点会重新注册；建议先禁用再删除。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => guard(n.nodeId)(ops.deleteNode(n.nodeId))}
            >
              <Button size="small" danger disabled={n.online || busyId === n.nodeId}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}

      {isRemote && pending.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${pending.length} 个节点等待审批`}
          description="批准后才可被任务绑定与调用。"
        />
      ) : null}

      <Card
        bordered
        title={<span style={{ fontSize: 14.5, fontWeight: 600 }}>{isRemote ? '远程节点' : '本机节点'}</span>}
        extra={
          isRemote ? (
            <Button type={showEnroll ? 'default' : 'primary'} icon={<PlusOutlined />} onClick={() => setShowEnroll((v) => !v)}>
              {showEnroll ? '收起接入指引' : '接入新机器'}
            </Button>
          ) : null
        }
      >
        {isRemote && showEnroll ? (
          <div style={{ marginBottom: 18, padding: 16, border: '1px solid #1e2430', borderRadius: 10, background: '#0d1017' }}>
            <NodeEnrollPanel base={props.base} token={props.token} onAuthError={props.onAuthError} />
          </div>
        ) : null}
        <Table
          rowKey="nodeId"
          columns={isRemote ? columns : columns.filter((c) => c.key !== 'ops')}
          dataSource={visible}
          loading={nodes === null}
          pagination={false}
          rowClassName={(n) => (n.status === 'pending' ? 'node-pending-row' : '')}
          locale={{
            emptyText: (
              <EmptyHint text={isRemote ? '暂无远程节点' : '本机网关节点不可用'} />
            ),
          }}
        />
      </Card>
    </div>
  );
}
