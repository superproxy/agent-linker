import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Col, Descriptions, Input, Row, Space, Tag } from 'antd';
import { ApiOutlined, CloudServerOutlined, DesktopOutlined } from '@ant-design/icons';
import { PmClient, type SystemInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { isLoopbackBase, processApiBase, type GatewayProfile } from '../lib/constants';
import {
  GatewayProfilesList,
  ProfileEditModal,
  useGatewayProfiles,
} from '../components/GatewayProfiles';

function GatewayInfoCard(props: {
  title: string;
  icon: ReactNode;
  hint: string;
  info: SystemInfo | null;
  err: string | null;
  extra?: ReactNode;
}) {
  return (
    <Card
      bordered
      title={
        <Space>
          {props.icon}
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>{props.title}</span>
        </Space>
      }
      extra={props.extra}
    >
      {props.err ? <Alert type="error" showIcon message={props.err} style={{ marginBottom: 12 }} /> : null}
      <div className="sub-muted" style={{ marginBottom: 12 }}>
        {props.hint}
      </div>
      <Descriptions
        column={{ xs: 1, sm: 2, lg: 4 }}
        labelStyle={{ color: 'rgba(229,233,240,0.5)' }}
        items={[
          {
            key: 'src',
            label: '来源',
            children: props.info ? (
              <Tag color={props.info.local ? 'green' : 'orange'} style={{ borderRadius: 999 }}>
                {props.info.local ? '本机' : '远程'}
              </Tag>
            ) : (
              '—'
            ),
          },
          {
            key: 'listen',
            label: '监听地址',
            children: props.info ? (
              <code className="code-cell">
                {props.info.host}:{props.info.port}
              </code>
            ) : (
              '—'
            ),
          },
          {
            key: 'auth',
            label: '访问鉴权',
            children: (
              <code className="code-cell">
                {props.info ? (props.info.authEnabled ? '已开启' : '未开启（仅本地开发）') : '—'}
              </code>
            ),
          },
          {
            key: 'ttl',
            label: '登录会话有效期',
            children: <code className="code-cell">{props.info ? `${props.info.sessionTtlDays} 天` : '—'}</code>,
          },
        ]}
      />
    </Card>
  );
}

function useSystemInfo(base: string, token: string, onAuthError: AuthErrorHandler) {
  const client = useMemo(() => new PmClient(base, () => token), [base, token]);
  const { tick } = useRefreshTick();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .systemInfo()
      .then((i) => alive && (setInfo(i), setErr(null)))
      .catch((e) => {
        if (!onAuthError(e) && alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  return { info, err };
}

/** 打开后台的这台机器上的网关（与进程管理同一地址） */
export function LocalGatewayPage(props: {
  token: string;
  onAuthError: AuthErrorHandler;
  onApplyBase: (next: string) => void;
}) {
  const localBase = processApiBase();
  const { info, err } = useSystemInfo(localBase, props.token, props.onAuthError);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24}>
        <GatewayInfoCard
          title="本地网关"
          icon={<DesktopOutlined />}
          hint={`当前打开后台的地址 ${localBase}（web 与网关同端口）。切到远程网关后，进程管理仍操作这台机器。`}
          info={info}
          err={err}
          extra={
            <Button type="primary" onClick={() => props.onApplyBase(localBase)}>
              控制台切回本机
            </Button>
          }
        />
      </Col>
    </Row>
  );
}

/** 浏览器保存的远程网关清单，以及控制台连过去的地址 */
export function RemoteGatewayPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onApplyBase: (next: string) => void;
}) {
  const { info, err } = useSystemInfo(props.base, props.token, props.onAuthError);
  const { profiles, upsert, remove } = useGatewayProfiles();
  const [baseDraft, setBaseDraft] = useState(props.base);
  const [modal, setModal] = useState<{ open: boolean; editing: GatewayProfile | null }>({
    open: false,
    editing: null,
  });

  useEffect(() => {
    setBaseDraft(props.base);
  }, [props.base]);

  const applyBase = (url: string) => {
    const next = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(next)) {
      notify.error('网关地址需以 http:// 或 https:// 开头');
      return;
    }
    props.onApplyBase(next);
  };

  const connectedRemote = !isLoopbackBase(props.base);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24}>
        <Card
          bordered
          title={
            <Space>
              <ApiOutlined />
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>控制台连接</span>
            </Space>
          }
        >
          <div className="sub-muted" style={{ marginBottom: 8 }}>
            管理后台当前请求的网关地址。输入完整后点击「切换并重连」才会切换；切回本机请用「本机 · 网关」。
          </div>
          <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
            <Input
              value={baseDraft}
              onChange={(e) => setBaseDraft(e.target.value)}
              onPressEnter={() => applyBase(baseDraft)}
              spellCheck={false}
              placeholder="http://192.168.1.10:8787"
            />
            <Button type="primary" onClick={() => applyBase(baseDraft)}>
              切换并重连
            </Button>
          </Space.Compact>
        </Card>
      </Col>
      <Col xs={24}>
        <GatewayInfoCard
          title="当前连接"
          icon={<CloudServerOutlined />}
          hint={connectedRemote ? '控制台正连向远程网关。' : '控制台当前连的是本机；从下方清单点「连接」可切到远程。'}
          info={info}
          err={err}
        />
      </Col>
      <Col xs={24}>
        <Card
          bordered
          title={
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>已保存的远程网关</span>
          }
        >
          <div className="sub-muted" style={{ marginBottom: 12 }}>
            仅保存在当前浏览器，供控制台切换和进程挂载时选择。
          </div>
          <GatewayProfilesList
            profiles={profiles}
            onEdit={(p) => setModal({ open: true, editing: p })}
            onRemove={(p) => void remove(p)}
            onAdd={() => setModal({ open: true, editing: null })}
            onConnect={(p) => applyBase(p.url)}
          />
        </Card>
      </Col>
      <ProfileEditModal
        open={modal.open}
        profile={modal.editing}
        onCancel={() => setModal({ open: false, editing: null })}
        onSubmit={(values) => {
          upsert(modal.editing, values);
          setModal({ open: false, editing: null });
        }}
      />
    </Row>
  );
}
