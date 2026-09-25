import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import { ApiError, OpsClient, type NodeInfo, type NodeTokenInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { CopyableCode, EmptyHint, StateTag } from '../components/common';
import { relTime, type TabId } from '../lib/constants';
import { NodeEnrollPanel } from './NodeEnroll';

export function NodesPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  scope: 'local' | 'remote';
  isAdmin?: boolean;
  username?: string;
  onGoTab?: (tab: TabId) => void;
}) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [nodeTokens, setNodeTokens] = useState<NodeTokenInfo[]>([]);
  const [viewNt, setViewNt] = useState<{ preview: string; full: string; label?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);

  const tokenByNodeId = useMemo(() => {
    const m = new Map<string, NodeTokenInfo>();
    for (const t of nodeTokens) {
      if (t.nodeId) m.set(t.nodeId, t);
    }
    return m;
  }, [nodeTokens]);

  const load = useCallback(async () => {
    try {
      const listNodes = ops.listNodes();
      const listTokens = props.scope === 'remote' ? ops.listNodeTokens().catch((e) => {
        if (e instanceof ApiError && e.status === 401) return [] as NodeTokenInfo[];
        throw e;
      }) : Promise.resolve([] as NodeTokenInfo[]);
      const [nextNodes, nextTokens] = await Promise.all([listNodes, listTokens]);
      setNodes(nextNodes);
      setNodeTokens(nextTokens);
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, props.scope, tick]);

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
  const isAdmin = props.isAdmin ?? false;

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
    ...(isRemote
      ? [
          {
            title: '节点 Key（nt_）',
            key: 'nodeKey',
            width: 120,
            responsive: ['md'] as const,
            render: (_: unknown, n: NodeInfo) => {
              const tok = tokenByNodeId.get(n.nodeId);
              if (!tok) return <span className="sub-muted">—</span>;
              return (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => setViewNt({ preview: tok.tokenPreview, full: tok.token, label: tok.label })}
                >
                  <code className="code-cell">{tok.tokenPreview}</code>
                </Button>
              );
            },
          } satisfies ColumnsType<NodeInfo>[number],
        ]
      : []),
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
        const canApprove = isAdmin || (!!props.username && n.ownerUsername === props.username);
        if (isPending)
          return (
            <Space size={6}>
              {canApprove ? (
                <>
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
                </>
              ) : (
                <span className="sub-muted">等待审批</span>
              )}
              <Popconfirm
                title={`删除节点「${n.name}」的接入申请？`}
                description="删除后需重新走接入流程。"
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
              description={
                isAdmin
                  ? '节点将被断开连接，路由层忽略；后续重连会被拒，可在本页重新启用。'
                  : '节点将被断开连接，任务无法路由到该机器；停用后需在本页「启用」才能重连。'
              }
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

      <Modal
        open={viewNt !== null}
        title="节点 Key（nt_）"
        onCancel={() => setViewNt(null)}
        footer={<Button onClick={() => setViewNt(null)}>关闭</Button>}
        destroyOnClose
      >
        {viewNt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {viewNt.label ? <div className="sub-muted">备注：{viewNt.label}</div> : null}
            <div className="sub-muted">完整凭证</div>
            <CopyableCode text={viewNt.full} block size={13} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
