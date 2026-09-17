import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Input, Row, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiOutlined, ControlOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import { PmClient, type PmProcess, type SystemInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';

function waitGatewayBack(client: PmClient, timeoutMs = 40_000): Promise<void> {
  const start = Date.now();
  return (async function loop(): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        await client.systemInfo();
        return;
      } catch {
        if (Date.now() - start > timeoutMs) return;
      }
    }
  })();
}

function ProcessManager(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const client = useMemo(() => new PmClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [procs, setProcs] = useState<PmProcess[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restartingGw, setRestartingGw] = useState(false);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [logBusy, setLogBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProcs(await client.status());
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (id: string, op: 'start' | 'stop' | 'restart') => {
    if (op === 'restart' && id === 'gateway') {
      const ok = await confirmAsync({
        title: '确认重启网关？',
        content: '期间网页与 OpenAI 接口会短暂中断（约数秒），微信/节点会自动重连。',
        okText: '重启网关',
      });
      if (!ok) return;
    }
    setBusyId(`${id}:${op}`);
    setErr(null);
    try {
      if (op === 'start') setProcs(await client.start([id]));
      else if (op === 'stop') setProcs(await client.stop([id]));
      else {
        const r = await client.restart([id]);
        if (r.gateway) {
          setRestartingGw(true);
          notify.info('网关重启中，等待恢复…');
          await waitGatewayBack(client);
          setRestartingGw(false);
          notify.success('网关已恢复');
        }
        if (r.processes) setProcs(r.processes);
      }
      await refresh();
    } catch (e) {
      if (!props.onAuthError(e)) {
        setErr(e instanceof Error ? e.message : String(e));
        setRestartingGw(false);
      }
    } finally {
      setBusyId(null);
    }
  };

  const toggleLog = async (id: string) => {
    if (logFor === id) {
      setLogFor(null);
      return;
    }
    setLogFor(id);
    setLogBusy(true);
    try {
      setLogText(await client.logs(id, 200));
    } catch (e) {
      if (!props.onAuthError(e)) setLogText(`读取日志失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLogBusy(false);
    }
  };

  const columns: ColumnsType<PmProcess> = [
    {
      title: '进程',
      dataIndex: 'label',
      key: 'label',
      render: (label: string, p) => (
        <Space>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: p.running ? '#22c55e' : '#ef4444',
              boxShadow: p.running ? '0 0 6px rgba(34,197,94,0.6)' : 'none',
              display: 'inline-block',
            }}
          />
          <code className="code-cell" style={{ fontSize: 13 }}>{label}</code>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 180,
      render: (_, p) =>
        p.running ? (
          <Tag color="success" style={{ borderRadius: 999 }}>
            运行中{p.pid ? ` · pid ${p.pid}` : ''}
          </Tag>
        ) : (
          <Tag style={{ borderRadius: 999 }}>已停止</Tag>
        ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 300,
      render: (_, p) => {
        const busy = (bid: string) => busyId === bid;
        return (
          <Space size={6} wrap>
            {p.id === 'gateway' ? (
              <Button size="small" icon={<ReloadOutlined />} disabled={busyId?.startsWith('gateway:') || restartingGw} onClick={() => void act(p.id, 'restart')}>
                重启
              </Button>
            ) : (
              <>
                <Button size="small" disabled={busy(`${p.id}:start`) || p.running} onClick={() => void act(p.id, 'start')}>
                  启动
                </Button>
                <Button size="small" danger disabled={busy(`${p.id}:stop`) || !p.running} onClick={() => void act(p.id, 'stop')}>
                  停止
                </Button>
                <Button size="small" icon={<ReloadOutlined />} disabled={busy(`${p.id}:restart`)} onClick={() => void act(p.id, 'restart')}>
                  重启
                </Button>
              </>
            )}
            <Button size="small" icon={<FileTextOutlined />} onClick={() => void toggleLog(p.id)}>
              {logFor === p.id ? '收起日志' : '日志'}
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      bordered
      title={
        <Space>
          <ControlOutlined />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>进程管理</span>
        </Space>
      }
      extra={
        <Button size="small" onClick={() => void refresh()}>
          刷新
        </Button>
      }
    >
      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}
      {restartingGw ? <Alert type="info" showIcon message="网关重启中，等待恢复…" style={{ marginBottom: 12 }} /> : null}
      <Table rowKey="id" columns={columns} dataSource={procs ?? []} loading={procs === null} pagination={false} expandable={{
        expandedRowKeys: logFor ? [logFor] : [],
        showExpandColumn: false,
        expandedRowRender: (p) => (
          <div>
            <div className="sub-muted" style={{ marginBottom: 6 }}>
              {p.logFile}
            </div>
            <pre className="pm-log">{logBusy ? '读取中…' : logText || '（暂无日志）'}</pre>
          </div>
        ),
      }} />
    </Card>
  );
}

export function SettingsPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onBaseChange: (v: string) => void;
  onApplyBase: () => void;
}) {
  const client = useMemo(() => new PmClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .systemInfo()
      .then((i) => alive && (setInfo(i), setErr(null)))
      .catch((e) => {
        if (!props.onAuthError(e) && alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24}>
        <Card
          bordered
          title={
            <Space>
              <ApiOutlined />
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>网关连接</span>
            </Space>
          }
        >
          {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}
          <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
            <Input value={props.base} onChange={(e) => props.onBaseChange(e.target.value)} spellCheck={false} />
            <Button type="primary" onClick={props.onApplyBase}>
              切换并重连
            </Button>
          </Space.Compact>
          <Descriptions
            column={{ xs: 1, sm: 2, lg: 4 }}
            style={{ marginTop: 18 }}
            labelStyle={{ color: 'rgba(229,233,240,0.5)' }}
            items={[
              {
                key: 'src',
                label: '来源',
                children: info ? (
                  <Tag color={info.local ? 'green' : 'orange'} style={{ borderRadius: 999 }}>
                    {info.local ? '本机' : '远程网关'}
                  </Tag>
                ) : (
                  '—'
                ),
              },
              {
                key: 'listen',
                label: '监听地址',
                children: info ? <code className="code-cell">{info.host}:{info.port}</code> : '—',
              },
              {
                key: 'auth',
                label: '访问鉴权',
                children: <code className="code-cell">{info ? (info.authEnabled ? '已开启' : '未开启（仅本地开发）') : '—'}</code>,
              },
              {
                key: 'ttl',
                label: '登录会话有效期',
                children: <code className="code-cell">{info ? `${info.sessionTtlDays} 天` : '—'}</code>,
              },
            ]}
          />
        </Card>
      </Col>
      {info?.local ? (
        <Col xs={24}>
          <ProcessManager base={props.base} token={props.token} onAuthError={props.onAuthError} />
        </Col>
      ) : null}
    </Row>
  );
}
