import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Row, Space, Spin, Tag } from 'antd';
import { QrcodeOutlined, ReloadOutlined } from '@ant-design/icons';
import { WeixinClient, type WeixinStatus } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';

export function WeixinPage(props: { base: string; token: string; onAuthError: AuthErrorHandler; onStatus?: (s: WeixinStatus | null) => void }) {
  const wx = useMemo(() => new WeixinClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [status, setStatus] = useState<WeixinStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await wx.status();
      setStatus(s);
      setErr(null);
      props.onStatus?.(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      props.onStatus?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wx, tick]);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const startScan = async (accountId?: string) => {
    setMsg(null);
    setScanning(true);
    setQr(null);
    try {
      const r = await wx.startQr(accountId);
      if (!r.qrDataUrl) {
        setMsg({ type: 'error', text: '二维码图片生成失败，请稍后重试' });
        setScanning(false);
        return;
      }
      setQr(r.qrDataUrl);
      setMsg({ type: 'info', text: accountId ? `请扫码重新绑定账号 ${accountId}` : '请用手机微信扫一扫完成绑定' });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const st = await wx.qrStatus(r.sessionKey, 8_000, accountId);
          if (st.connected) {
            if (pollRef.current) clearInterval(pollRef.current);
            setScanning(false);
            setMsg({
              type: 'success',
              text: `绑定成功：账号 ${st.accountId ?? accountId ?? ''}。可点「重启渠道」立即生效。`,
            });
            await refresh();
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          setScanning(false);
          setMsg({ type: 'error', text: `扫码状态查询失败：${e instanceof Error ? e.message : String(e)}` });
        }
      }, 8_000);
    } catch (e) {
      setScanning(false);
      setMsg({ type: 'error', text: `发起扫码失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const cancelScan = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setScanning(false);
    setQr(null);
    setMsg(null);
  };

  const reloadChannel = async () => {
    setMsg({ type: 'info', text: '正在重启微信渠道…' });
    try {
      await wx.reload();
      setMsg({ type: 'success', text: '微信渠道已重启' });
      notify.success('微信渠道已重启');
      await refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `重启失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <Card
          bordered
          title={
            <Space>
              <QrcodeOutlined />
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>聊天机器人绑定</span>
            </Space>
          }
        >
          {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 14 }} /> : null}

          <Descriptions
            column={1}
            size="small"
            labelStyle={{ width: 110, color: 'rgba(229,233,240,0.5)' }}
            items={[
              {
                key: 'state',
                label: '绑定状态',
                children: status ? (
                  <Tag color={status.configured ? 'success' : 'error'} style={{ borderRadius: 999 }}>
                    {status.configured ? '已绑定' : '未绑定'}
                  </Tag>
                ) : (
                  <Spin size="small" />
                ),
              },
              {
                key: 'active',
                label: '当前账号',
                children: <code className="code-cell">{status?.activeAccountId || '—'}</code>,
              },
            ]}
          />

          {status && status.accounts.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div className="sub-muted" style={{ marginBottom: 6 }}>
                已保存账号
              </div>
              <Space direction="vertical" size={4}>
                {status.accounts.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code className="code-cell">{a.id}</code>
                    {a.userId ? <span className="sub-muted"> · {a.userId}</span> : null}
                    {a.savedAt ? <span className="sub-muted"> · {a.savedAt}</span> : null}
                    <Button size="small" disabled={scanning} onClick={() => void startScan(a.id)}>
                      重新绑定
                    </Button>
                  </div>
                ))}
              </Space>
            </div>
          ) : null}

          <Space style={{ marginTop: 18 }} wrap>
            <Button type="primary" loading={scanning} onClick={() => void startScan()}>
              {scanning ? '等待扫码…' : status?.configured ? '重新绑定' : '绑定微信机器人'}
            </Button>
            {scanning ? <Button onClick={cancelScan}>取消</Button> : null}
            {status?.configured ? (
              <Button icon={<ReloadOutlined />} onClick={() => void reloadChannel()}>
                重启渠道
              </Button>
            ) : null}
          </Space>

          {msg ? <Alert style={{ marginTop: 14 }} type={msg.type} showIcon message={msg.text} /> : null}
        </Card>
      </Col>

      <Col xs={24} lg={10}>
        <Card bordered title={<span style={{ fontSize: 14.5, fontWeight: 600 }}>扫码二维码</span>}>
          <div style={{ display: 'grid', placeItems: 'center', padding: '12px 0' }}>
            {qr ? (
              <img
                src={qr}
                alt="微信绑定二维码"
                style={{ width: 240, height: 240, borderRadius: 12, border: '1px solid #232a36', background: '#fff', padding: 8 }}
              />
            ) : (
              <div
                style={{
                  width: 240,
                  height: 240,
                  borderRadius: 12,
                  border: '1px dashed #2a323f',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'rgba(229,233,240,0.35)',
                  fontSize: 13,
                  textAlign: 'center',
                  padding: 20,
                }}
              >
                {scanning ? <Spin tip="生成二维码…" /> : '点击「绑定微信机器人」生成二维码'}
              </div>
            )}
          </div>
          <p className="sub-muted" style={{ textAlign: 'center', margin: 0 }}>
            使用登录该机器人的微信账号扫码
          </p>
        </Card>
      </Col>
    </Row>
  );
}
