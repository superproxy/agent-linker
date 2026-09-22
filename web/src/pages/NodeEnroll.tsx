import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Col, Input, Row, Segmented, Space, Steps, Tag } from 'antd';
import { OpsClient, type NodeEnrollInfo } from '../api';
import { notify } from '../lib/notify';
import type { AuthErrorHandler } from '../lib/hooks';
import { formatNodeEnv, NODE_ENV_FLAVOR_OPTIONS, type NodeEnvFlavor } from '../lib/node-env';
import { NodeKeyPanel } from '../components/node-key-panel';

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

export function NodeEnrollPanel(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
}) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [info, setInfo] = useState<NodeEnrollInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState('node-1');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [envFlavor, setEnvFlavor] = useState<NodeEnvFlavor>('dotenv');
  const [claimToken, setClaimToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const i = await ops.nodeEnroll();
        if (!alive) return;
        setInfo(i);
        setUrl(guessGatewayUrl(i.port));
        setAgents(Object.fromEntries(i.defaultAgents.map((a) => [a.id, true])));
        try {
          const c = await ops.ensureNodeClaim();
          if (alive) setClaimToken(c.claimToken);
        } catch {
          /* 未登录会话时跳过 */
        }
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

  if (loadErr) return <Alert type="error" showIcon message={loadErr} />;
  if (!info) return <Alert type="info" showIcon message="正在加载接入信息…" />;

  const instName = name.trim() || 'node-1';
  const chosen = Object.keys(agents).filter((id) => agents[id]);
  const agentsLine = chosen.length > 0 ? chosen.join(',') : info.defaultAgents.map((a) => a.id).join(',');
  const envPath = `.runtime-state/node-${instName}.env`;
  const startCmd = `pnpm node:start ${instName}`;
  const envFields = { gatewayUrl: url, agents: agentsLine };
  const envDirect = formatNodeEnv({ ...envFields, token: info.token || undefined }, envFlavor);
  const envApproval = formatNodeEnv(
    { ...envFields, ...(claimToken ? { claimToken } : {}) },
    envFlavor,
  );
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={12}>
        <Col xs={24} sm={8}>
          <div className="sub-muted" style={{ marginBottom: 4 }}>
            节点实例名
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="node-1" />
        </Col>
        <Col xs={24} sm={16}>
          <div className="sub-muted" style={{ marginBottom: 4 }}>
            网关地址（节点机可达）
          </div>
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

      {isLoopback ? (
        <Tag color="default">当前地址指向回环地址，仅适用于节点与网关同机；跨机请改成网关机 IP 或域名。</Tag>
      ) : null}

      <Steps
        size="small"
        current={3}
        direction="vertical"
        items={[
          { title: '准备运行环境', description: '执行机安装 Node ≥ 22.13、pnpm，以及代码/发布包和所需 agent CLI。' },
          {
            title: '颁发节点 Key 并配置环境变量',
            description:
              envFlavor === 'dotenv' ? (
                <>
                  在「我的 · 节点 Key」颁发 nt_，并在项目根目录创建 <code>{envPath}</code>。
                </>
              ) : (
                <>在「我的 · 节点 Key」颁发 nt_，在节点机终端粘贴下方 {envFlavor === 'bash' ? 'Bash' : 'PowerShell'} 片段。</>
              ),
          },
          { title: '启动节点', description: <><code>{startCmd}</code>（前台调试可用 <code>pnpm node:dev {instName}</code>）。</> },
        ]}
      />

      <div>
        <div className="sub-muted" style={{ marginBottom: 8 }}>
          环境变量格式（颁发 nt_ 后下方生成对应片段）
        </div>
        <Segmented value={envFlavor} options={NODE_ENV_FLAVOR_OPTIONS} onChange={(v) => setEnvFlavor(v as NodeEnvFlavor)} />
        <div className="sub-muted" style={{ marginTop: 8 }}>
          {envHint}
        </div>
      </div>

      <NodeKeyPanel
        base={props.base}
        token={props.token}
        onAuthError={props.onAuthError}
        embedded
        envContext={{ gatewayUrl: url, agents: agentsLine }}
        envFlavor={envFlavor}
      />

      <Row gutter={[14, 14]}>
        {info.token || !info.authEnabled ? (
          <Col xs={24} md={12}>
            <div className="enroll-block">
              <div>
                <strong>网关令牌直连</strong>
                <div className="sub-muted" style={{ marginTop: 2 }}>
                  管理员/本机可用网关 token，连上即上线
                </div>
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
              <div className="sub-muted" style={{ marginTop: 2 }}>
                不含网关 token；含 <code>LINKAGENT_NODE_CLAIM</code>（nu_）标明你的登录账号，管理员可见属主
              </div>
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
