import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Input, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { StarFilled } from '@ant-design/icons';
import { AdminClient, type AgentCatalogItem, type AgentDetail, type RemoteNodeAgentView } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { CopyableCode, EmptyHint, PageCard, StateTag } from '../components/common';
import { relTime } from '../lib/constants';

const { Text } = Typography;

function nodeState(n: RemoteNodeAgentView): 'on' | 'off' | 'pending' | 'blocked' {
  if (n.status === 'pending') return 'pending';
  if (n.status === 'blocked') return 'blocked';
  return n.online ? 'on' : 'off';
}

export function AgentsPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  scope: 'local' | 'remote';
  onGoNodes?: () => void;
}) {
  const admin = new AdminClient(props.base, props.token);
  const { tick } = useRefreshTick();
  const [data, setData] = useState<{
    defaultAgentId: string;
    local: AgentDetail[];
    nodes: RemoteNodeAgentView[];
  } | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalogItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [install, setInstall] = useState<{
    kind: string;
    displayName: string;
    command: string;
    hint?: string;
    runnable: boolean;
  } | null>(null);
  const [installLog, setInstallLog] = useState('');
  const [installBusy, setInstallBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // 远程页只读自己机器上连接器自报的 agent；目录/添加/安装是本机网关能力，仅管理员接口。
      if (props.scope === 'remote') {
        const v = await admin.agentsByNode();
        setData({ defaultAgentId: v.defaultAgentId ?? '', local: [], nodes: v.nodes });
        setCatalog([]);
      } else {
        const [v, cat] = await Promise.all([admin.agentsByNode(), admin.catalog()]);
        setData({ defaultAgentId: v.defaultAgentId ?? '', local: v.local?.agents ?? [], nodes: v.nodes });
        setCatalog(cat);
      }
      setErr(null);
    } catch (e) {
      if (props.onAuthError(e)) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.base, props.token, tick, props.scope]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
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

  const openInstall = (c: Pick<AgentCatalogItem, 'kind' | 'displayName' | 'command' | 'installCommand' | 'installHint' | 'installRunnable'>) => {
    setInstallLog('');
    setInstall({
      kind: c.kind,
      displayName: c.displayName,
      command: c.installCommand || (c.command ?? []).join(' '),
      hint: c.installHint,
      runnable: Boolean(c.installRunnable),
    });
  };

  const copyInstall = async () => {
    if (!install?.command) return;
    try {
      await navigator.clipboard.writeText(install.command);
      notify.success('已复制安装命令');
    } catch {
      notify.error('复制失败，请手动选择命令框中的文本');
    }
  };

  const executeInstall = async () => {
    if (!install) return;
    setInstallBusy(true);
    try {
      const r = await admin.installAgentCli(install.kind);
      const parts = [r.stdout.trim(), r.stderr.trim()];
      if (!r.ok) parts.push(`退出码 ${r.exitCode}`);
      setInstallLog(parts.filter(Boolean).join('\n') || (r.ok ? '完成' : '失败'));
      if (r.ok) notify.success(`安装完成：${install.displayName}`);
      else notify.error(`安装未成功：${install.displayName}`);
    } catch (e) {
      if (props.onAuthError(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      setInstallLog(msg);
      notify.error(msg);
    } finally {
      setInstallBusy(false);
    }
  };

  const defaultAgentId = data?.defaultAgentId ?? null;
  const available = catalog.filter((c) => !c.configured);

  const localColumns: ColumnsType<AgentDetail> = [
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
      render: (v?: string) => (v ? <Text code style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">—</Text>),
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
      width: 240,
      render: (_, a) => {
        const cat = catalog.find((c) => c.kind === a.type);
        return (
        <Space size={6} wrap>
          <Tooltip title={a.id === 'pi' ? '默认任务固定为本机 pi' : '设为任务全空时的路由兜底（默认任务仍固定本机 pi）'}>
            <Button
              size="small"
              disabled={a.id === defaultAgentId || busyId === a.id}
              onClick={() => void run(a.id, () => admin.setDefaultAgent(a.id), `已设置空列表兜底 agent：${a.id}`)}
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
          {cat ? (
            <Button size="small" onClick={() => openInstall(cat)}>
              安装
            </Button>
          ) : null}
        </Space>
        );
      },
    },
  ];

  const catalogColumns: ColumnsType<AgentCatalogItem> = [
    {
      title: 'Agent',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (v: string, c) => (
        <Space size={8}>
          <Text strong>{v}</Text>
          <Text code style={{ fontSize: 12, fontWeight: 400 }}>{c.kind}</Text>
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
      title: '启动命令',
      dataIndex: 'command',
      key: 'command',
      responsive: ['lg'],
      render: (cmd?: string[]) =>
        cmd?.length ? <Text code style={{ fontSize: 12 }}>{cmd.join(' ')}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: '安装命令',
      dataIndex: 'installCommand',
      key: 'installCommand',
      responsive: ['lg'],
      render: (cmd?: string) =>
        cmd ? <CopyableCode text={cmd} title="点击复制安装命令" /> : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      render: (_, c) => (
        <Space size={6}>
          <Button size="small" onClick={() => openInstall(c)}>
            安装
          </Button>
          <Button
            size="small"
            type="primary"
            ghost
            loading={busyId === `add:${c.kind}`}
            disabled={busyId !== null && busyId !== `add:${c.kind}`}
            onClick={() =>
              void run(
                `add:${c.kind}`,
                () => admin.addAgentByType(c.kind),
                `已添加并启用：${c.displayName}`,
              )
            }
          >
            添加并启用
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {err ? <Alert type="error" showIcon message={err} /> : null}

      {props.scope === 'local' ? (
      <PageCard
        title="本机（网关）"
        subtitle="这台机器开通的 agent，来自网关配置，可在此启停、切模型、设为新任务默认。"
        loading={data === null}
      >
        <Table
          rowKey="id"
          columns={localColumns}
          dataSource={data?.local ?? []}
          pagination={false}
          size="middle"
          locale={{ emptyText: <EmptyHint text="本机暂无 agent，请检查网关配置" /> }}
          rowClassName={(a) => (a.id === defaultAgentId ? 'agent-default-row' : '')}
        />
        <p className="page-desc" style={{ marginTop: 12, marginBottom: 0 }}>
          启停会写入 config.yaml，重启后保留；切模型仍为运行时热更新（重启网关后还原 yaml 中的 model）。
        </p>

        <Divider style={{ margin: '16px 0 12px' }} orientation="left" orientationMargin={0}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            添加 Agent（{available.length} 个可添加）
          </Text>
        </Divider>
        <Table
          rowKey="kind"
          columns={catalogColumns}
          dataSource={available}
          pagination={available.length > 8 ? { pageSize: 8, size: 'small' } : false}
          size="small"
          locale={{ emptyText: <EmptyHint text="所有支持的 agent 类型均已配置" /> }}
        />
        <p className="page-desc" style={{ marginTop: 10, marginBottom: 0 }}>
          添加为运行时热生效（重启网关后还原 config.yaml，需长期保留请写入配置）。未装 CLI 时点「安装」查看命令；npm 全局包可由网关代执行，含管道的安装请复制到本机终端。
        </p>
      </PageCard>
      ) : null}

      {props.scope === 'remote' && data === null ? (
        <PageCard title="远程机器" subtitle="连接器自报开通的 agent，网关侧只读。" loading>
          <EmptyHint text="加载中…" />
        </PageCard>
      ) : null}

      {props.scope === 'remote'
        ? (data?.nodes ?? []).map((n) => {
        const st = nodeState(n);
        return (
          <PageCard
            key={n.nodeId}
            title={
              <Space size={8}>
                <span>{n.name}</span>
                <Text code style={{ fontSize: 12, fontWeight: 400 }}>{n.nodeId}</Text>
              </Space>
            }
            subtitle={`远程机器 · 开通 ${n.agents.length} 个 agent${n.version ? ` · v${n.version}` : ''}`}
            extra={
              <Space size={10}>
                <StateTag state={st} />
                {n.status === 'pending' && props.onGoNodes ? (
                  <Button size="small" type="primary" onClick={props.onGoNodes}>
                    去审批
                  </Button>
                ) : null}
              </Space>
            }
          >
            {n.agents.length ? (
              <Space size={6} wrap>
                {n.agents.map((a) => (
                  <Tooltip key={a.id} title={a.displayName && a.displayName !== a.id ? a.displayName : a.id}>
                    <Tag style={{ borderRadius: 6, marginInlineEnd: 0, opacity: n.online ? 1 : 0.55 }}>
                      {a.displayName || a.id}
                      {a.displayName && a.displayName !== a.id ? <span className="sub-muted"> · {a.id}</span> : null}
                    </Tag>
                  </Tooltip>
                ))}
              </Space>
            ) : (
              <EmptyHint text="该机器未上报任何 agent" />
            )}
            <div className="sub-muted" style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.7 }}>
              <div>
                最近连接：{relTime(n.online || n.status === 'pending' ? (n.connectedAt ?? n.lastSeenAt ?? 0) : (n.lastSeenAt ?? 0))}
                {n.remoteAddress ? ` · ${n.remoteAddress}` : ''}
              </div>
              <div>
                开通情况由该机器自身决定：在机器上调整 <Text code style={{ fontSize: 11.5 }}>LINKAGENT_NODE_AGENTS</Text>（或 config.yaml 的 node.agents）后重连生效，网关侧只读。
              </div>
            </div>
          </PageCard>
        );
      })
        : null}

      {props.scope === 'remote' && data && data.nodes.length === 0 ? (
        <PageCard title="远程机器" subtitle="自己接入的节点连接器会在此列出开通的 agent（网关侧只读）。">
          <EmptyHint text="暂无自己的远程机器（可在「远程 · 节点」接入）" />
        </PageCard>
      ) : null}

      <Modal
        title={install ? `安装 ${install.displayName}` : '安装 Agent CLI'}
        open={Boolean(install)}
        onCancel={() => {
          if (installBusy) return;
          setInstall(null);
        }}
        destroyOnClose
        footer={
          <Space>
            <Button disabled={installBusy} onClick={() => setInstall(null)}>
              关闭
            </Button>
            <Button onClick={() => void copyInstall()} disabled={!install?.command || installBusy}>
              复制命令
            </Button>
            <Tooltip title={install && !install.runnable ? '此命令含管道或需交互，请复制到本机终端执行' : '按白名单在网关本机执行，不会使用你改写的文本'}>
              <Button type="primary" loading={installBusy} disabled={!install?.runnable} onClick={() => void executeInstall()}>
                在本机执行
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {install ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {install.hint ? <Text type="secondary" style={{ fontSize: 12.5 }}>{install.hint}</Text> : null}
            <Input.TextArea
              value={install.command}
              readOnly
              autoSize={{ minRows: 2, maxRows: 6 }}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 }}
            />
            {installLog ? (
              <pre
                style={{
                  margin: 0,
                  maxHeight: 220,
                  overflow: 'auto',
                  padding: 10,
                  borderRadius: 8,
                  background: 'rgba(0,0,0,0.28)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {installLog}
              </pre>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
