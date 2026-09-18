import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Input, Row, Space, Tag } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { PmClient, type SystemInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';

export function SettingsPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onApplyBase: (next: string) => void;
}) {
  const client = useMemo(() => new PmClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [baseDraft, setBaseDraft] = useState(props.base);

  useEffect(() => {
    setBaseDraft(props.base);
  }, [props.base]);

  const applyBase = () => {
    const url = baseDraft.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(url)) {
      notify.error('网关地址需以 http:// 或 https:// 开头');
      return;
    }
    props.onApplyBase(url);
  };

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
          <div className="sub-muted" style={{ marginBottom: 8 }}>
            管理后台连接的网关地址（输入完整后点击「切换并重连」才会切换）。进程管理始终跟你打开后台的那个地址走（本机 127 / 远程部署地址），与此处无关。
          </div>
          <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
            <Input
              value={baseDraft}
              onChange={(e) => setBaseDraft(e.target.value)}
              onPressEnter={applyBase}
              spellCheck={false}
              placeholder="http://127.0.0.1:8787"
            />
            <Button type="primary" onClick={applyBase}>
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
    </Row>
  );
}
