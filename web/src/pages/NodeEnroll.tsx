import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Col, Input, Row, Steps, Tag } from 'antd';
import { ApiError, OpsClient, type NodeEnrollInfo } from '../api';
import { notify } from '../lib/notify';
import type { AuthErrorHandler } from '../lib/hooks';

function guessGatewayUrl(port: number): string {
  if (typeof window === 'undefined') return `ws://GATEWAY_HOST:${port}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname || 'GATEWAY_HOST';
  return `${proto}://${host}:${port}`;
}

export function NodeEnrollPanel(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const [info, setInfo] = useState<NodeEnrollInfo | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState('node-1');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ops
      .nodeEnroll()
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        setUrl(guessGatewayUrl(i.port));
        setAgents(Object.fromEntries(i.defaultAgents.map((a) => [a.id, true])));
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [ops]);

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      notify.success('已复制到剪贴板');
    });
  };

  if (forbidden)
    return <Alert type="warning" showIcon message="仅管理员可查看节点接入命令（含网关令牌），请使用管理员账号登录。" />;
  if (loadErr) return <Alert type="error" showIcon message={loadErr} />;
  if (!info) return <Alert type="info" showIcon message="正在加载接入信息…" />;

  const instName = name.trim() || 'node-1';
  const chosen = Object.keys(agents).filter((id) => agents[id]);
  const agentsLine = chosen.length > 0 ? chosen.join(',') : info.defaultAgents.map((a) => a.id).join(',');
  const envPath = `.runtime-state/node-${instName}.env`;
  const startCmd = `pnpm node:start ${instName}`;

  const envDirect = [
    `LINKAGENT_GATEWAY_URL=${url}`,
    ...(info.authEnabled && info.token ? [`LINKAGENT_GATEWAY_TOKEN=${info.token}`] : []),
    `LINKAGENT_NODE_AGENTS=${agentsLine}`,
  ].join('\n');
  const envApproval = [`LINKAGENT_GATEWAY_URL=${url}`, `LINKAGENT_NODE_AGENTS=${agentsLine}`].join('\n');

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
          { title: '创建 env 文件', description: <>在项目根目录创建 <code>{envPath}</code>，选择下列任一方式。</> },
          { title: '启动节点', description: <><code>{startCmd}</code>（前台调试可用 <code>pnpm node:dev {instName}</code>）。</> },
        ]}
      />

      <Row gutter={[14, 14]}>
        <Col xs={24} md={12}>
          <div className="enroll-block">
            <div>
              <strong>方式一 · 令牌直连</strong>
              <div className="sub-muted" style={{ marginTop: 2 }}>env 含令牌，连上即上线，无需审批</div>
            </div>
            {!info.authEnabled ? <span className="sub-muted">网关当前未开启鉴权，无需令牌，任意连接自动上线。</span> : null}
            <pre className="enroll-pre">{envDirect}</pre>
            <Button size="small" onClick={() => copy('direct', envDirect)}>
              {copied === 'direct' ? '已复制' : '复制 env'}
            </Button>
          </div>
        </Col>
        <Col xs={24} md={12}>
          <div className="enroll-block">
            <div>
              <strong>方式二 · 申请审批</strong>
              <div className="sub-muted" style={{ marginTop: 2 }}>env 不含令牌；启动后在本页顶部待审批区点「批准」</div>
            </div>
            <pre className="enroll-pre">{envApproval}</pre>
            <Button size="small" onClick={() => copy('approval', envApproval)}>
              {copied === 'approval' ? '已复制' : '复制 env'}
            </Button>
          </div>
        </Col>
      </Row>

      <div className="enroll-cmd">
        <code>{startCmd}</code>
        <Button onClick={() => copy('cmd', startCmd)}>{copied === 'cmd' ? '已复制' : '复制命令'}</Button>
      </div>
      <p className="sub-muted" style={{ margin: 0, lineHeight: 1.6 }}>
        审批通过后网关会向节点签发专属凭证并保存在节点机 <code>.runtime-state/node-{instName}/node-secret</code>，
        此后断线重连无需再次审批；被拒绝的节点会停止重连，需删除记录后重新申请。
      </p>
    </div>
  );
}
