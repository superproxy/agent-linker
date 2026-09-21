import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Col, Input, Popconfirm, Row, Segmented, Space, Steps, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError, OpsClient, type NodeEnrollInfo, type NodeTokenInfo } from '../api';
import { notify } from '../lib/notify';
import type { AuthErrorHandler } from '../lib/hooks';
import { formatNodeEnv, NODE_ENV_FLAVOR_OPTIONS, type NodeEnvFlavor } from '../lib/node-env';

function guessGatewayUrl(port: number): string {
  if (typeof window === 'undefined') return `ws://GATEWAY_HOST:${port}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname || 'GATEWAY_HOST';
  return `${proto}://${host}:${port}`;
}

function copyEnvLabel(flavor: NodeEnvFlavor, copied: boolean): string {
  if (copied) return '已复制';
  if (flavor === 'bash') return '复制 Bash';
  if (flavor === 'powershell') return '复制 PowerShell';
  return '复制 env 文件';
}

export function NodeEnrollPanel(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [info, setInfo] = useState<NodeEnrollInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState('node-1');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [envFlavor, setEnvFlavor] = useState<NodeEnvFlavor>('dotenv');
  const [mine, setMine] = useState<NodeTokenInfo[]>([]);
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refreshTokens = async () => {
    try {
      setMine(await ops.listNodeTokens());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMine([]);
        return;
      }
      throw e;
    }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const i = await ops.nodeEnroll();
        if (!alive) return;
        setInfo(i);
        setUrl(guessGatewayUrl(i.port));
        setAgents(Object.fromEntries(i.defaultAgents.map((a) => [a.id, true])));
        await refreshTokens();
      } catch (e) {
        if (!alive) return;
        if (!props.onAuthError(e)) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops]);

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      notify.success('已复制到剪贴板');
    });
  };

  const issue = async () => {
    setBusy('issue');
    try {
      const r = await ops.issueNodeToken(label || name);
      setRevealed({ id: r.id, token: r.token });
      setLabel('');
      await refreshTokens();
      notify.success('已颁发机器凭证，请复制到节点 env');
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loadErr) return <Alert type="error" showIcon message={loadErr} />;
  if (!info) return <Alert type="info" showIcon message="正在加载接入信息…" />;

  const instName = name.trim() || 'node-1';
  const chosen = Object.keys(agents).filter((id) => agents[id]);
  const agentsLine = chosen.length > 0 ? chosen.join(',') : info.defaultAgents.map((a) => a.id).join(',');
  const envPath = `.runtime-state/node-${instName}.env`;
  const startCmd = `pnpm node:start ${instName}`;
  const envFields = { gatewayUrl: url, agents: agentsLine };
  const envDirect = formatNodeEnv({ ...envFields, token: info.token || undefined }, envFlavor);
  const envApproval = formatNodeEnv(envFields, envFlavor);
  const envMine = revealed ? formatNodeEnv({ ...envFields, token: revealed.token }, envFlavor) : '';
  const envHint =
    envFlavor === 'dotenv'
      ? `写入项目根目录 ${envPath}（启动脚本会自动加载）。`
      : envFlavor === 'bash'
        ? '粘贴到 Bash / zsh 当前会话后立刻生效，不落盘。随后执行下方启动命令。'
        : '粘贴到 PowerShell 当前会话后立刻生效，不落盘。随后执行下方启动命令。';

  const isLoopback = (() => {
    try {
      const h = new URL(url).hostname;
      return h === '::1' || /(^|\.)(127\.0\.0\.1|localhost)$/.test(h);
    } catch {
      return false;
    }
  })();

  const tokenCols: ColumnsType<NodeTokenInfo> = [
    {
      title: '凭证',
      key: 'p',
      render: (_, t) => (
        <div>
          <code className="code-cell">{t.tokenPreview}</code>
          {t.label ? <div className="sub-muted">{t.label}</div> : null}
        </div>
      ),
    },
    {
      title: '绑定机器',
      key: 'n',
      render: (_, t) => (t.nodeId ? <code className="code-cell">{t.nodeId}</code> : <span className="sub-muted">未连接</span>),
    },
    {
      title: '操作',
      key: 'ops',
      width: 160,
      render: (_, t) => (
        <Space size={6}>
          <Button
            size="small"
            disabled={busy === t.id}
            onClick={() =>
              void (async () => {
                setBusy(t.id);
                try {
                  const r = await ops.rotateNodeToken(t.id);
                  setRevealed({ id: r.id, token: r.token });
                  await refreshTokens();
                  notify.success('已轮换，请更新节点 env');
                } catch (e) {
                  if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              })()
            }
          >
            轮换
          </Button>
          <Popconfirm
            title="吊销这枚机器凭证？"
            okText="吊销"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              void (async () => {
                setBusy(t.id);
                try {
                  await ops.revokeNodeToken(t.id);
                  if (revealed?.id === t.id) setRevealed(null);
                  await refreshTokens();
                  notify.success('已吊销');
                } catch (e) {
                  if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              })()
            }
          >
            <Button size="small" danger disabled={busy === t.id}>
              吊销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={12}>
        <Col xs={24} sm={8}>
          <div className="sub-muted" style={{ marginBottom: 4 }}>节点实例名</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-1" />
        </Col>
        <Col xs={24} sm={16}>
          <div className="sub-muted" style={{ marginBottom: 4 }}>网关地址（节点机可达）</div>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://gw.example.com" />
        </Col>
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <span className="sub-muted">上报 Agent：</span>
        {info.defaultAgents.map((a) => (
          <Checkbox
            key={a.id}
            checked={agents[a.id] ?? false}
            onChange={(e) => setAgents((s) => ({ ...s, [a.id]: e.target.checked }))}
          >
            {a.displayName || a.id}
          </Checkbox>
        ))}
      </div>

      {isLoopback ? <Tag color="default">当前地址指向回环地址，仅适用于节点与网关同机；跨机请改成网关机 IP 或域名。</Tag> : null}

      <Steps
        size="small"
        current={3}
        direction="vertical"
        items={[
          { title: '准备运行环境', description: '执行机安装 Node ≥ 22.13、pnpm，以及代码/发布包和所需 agent CLI。' },
          {
            title: '颁发机器凭证并配置环境变量',
            description:
              envFlavor === 'dotenv' ? (
                <>在项目根目录创建 <code>{envPath}</code>。</>
              ) : (
                <>在节点机终端粘贴下方 {envFlavor === 'bash' ? 'Bash' : 'PowerShell'} 片段。</>
              ),
          },
          { title: '启动节点', description: <><code>{startCmd}</code>（前台调试可用 <code>pnpm node:dev {instName}</code>）。</> },
        ]}
      />

      <div>
        <div className="sub-muted" style={{ marginBottom: 8 }}>环境变量格式</div>
        <Segmented
          value={envFlavor}
          options={NODE_ENV_FLAVOR_OPTIONS}
          onChange={(v) => setEnvFlavor(v as NodeEnvFlavor)}
        />
        <div className="sub-muted" style={{ marginTop: 8 }}>{envHint}</div>
      </div>

      <div className="enroll-block">
        <div>
          <strong>我的机器凭证</strong>
          <div className="sub-muted" style={{ marginTop: 2 }}>每台机器一枚，连上即归你所有；与网关 token 均可使用</div>
        </div>
        <Space.Compact style={{ width: '100%', maxWidth: 480, margin: '8px 0' }}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注，例如家里的 PC" />
          <Button type="primary" loading={busy === 'issue'} onClick={() => void issue()}>
            颁发
          </Button>
        </Space.Compact>
        {revealed ? (
          <>
            <pre className="enroll-pre">{envMine}</pre>
            <Button size="small" onClick={() => copy('mine', envMine)}>
              {copyEnvLabel(envFlavor, copied === 'mine')}
            </Button>
          </>
        ) : null}
        <Table rowKey="id" size="small" pagination={false} columns={tokenCols} dataSource={mine} style={{ marginTop: 10 }} />
      </div>

      <Row gutter={[14, 14]}>
        {info.token || !info.authEnabled ? (
          <Col xs={24} md={12}>
            <div className="enroll-block">
              <div>
                <strong>网关令牌直连</strong>
                <div className="sub-muted" style={{ marginTop: 2 }}>管理员/本机可用网关 token，连上即上线</div>
              </div>
              {!info.authEnabled ? <span className="sub-muted">网关当前未开启鉴权，无需令牌。</span> : null}
              <pre className="enroll-pre">{envDirect}</pre>
              <Button size="small" onClick={() => copy('direct', envDirect)}>
                {copyEnvLabel(envFlavor, copied === 'direct')}
              </Button>
            </div>
          </Col>
        ) : null}
        <Col xs={24} md={12}>
          <div className="enroll-block">
            <div>
              <strong>申请审批</strong>
              <div className="sub-muted" style={{ marginTop: 2 }}>不含令牌；启动后由管理员批准</div>
            </div>
            <pre className="enroll-pre">{envApproval}</pre>
            <Button size="small" onClick={() => copy('approval', envApproval)}>
              {copyEnvLabel(envFlavor, copied === 'approval')}
            </Button>
          </div>
        </Col>
      </Row>

      <div className="enroll-cmd">
        <code>{startCmd}</code>
        <Button onClick={() => copy('cmd', startCmd)}>{copied === 'cmd' ? '已复制' : '复制命令'}</Button>
      </div>
    </div>
  );
}
