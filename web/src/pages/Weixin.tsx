import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Row, Space, Spin, Steps, Tag } from 'antd';
import { QrcodeOutlined, ReloadOutlined } from '@ant-design/icons';
import { WeixinClient, type WeixinStatus } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';

export function WeixinPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onStatus?: (s: WeixinStatus | null) => void;
  username?: string;
}) {
  const wx = useMemo(() => new WeixinClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [status, setStatus] = useState<WeixinStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [msg, setMsg] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      abortRef.current?.abort();
    };
  }, [refresh]);

  const startScan = async (accountId?: string) => {
    const slot = accountId ?? status?.bindAccountId;
    setMsg(null);
    setScanning(true);
    setQr(null);
    try {
      const r = await wx.startQr(slot);
      if (!r.qrDataUrl) {
        setMsg({ type: 'error', text: '二维码图片生成失败，请稍后重试' });
        setScanning(false);
        return;
      }
      setQr(r.qrDataUrl);
      setMsg({ type: 'info', text: slot ? `请扫码绑定账号槽 ${slot}（将启动进程 weixin:${slot}）` : '请用手机微信扫一扫完成绑定' });
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const st = await wx.qrStatus(r.sessionKey, 120_000, slot, ac.signal);
        if (ac.signal.aborted) return;
        setScanning(false);
        if (st.connected) {
          setMsg({
            type: st.boundWarning ? 'info' : 'success',
            text: st.boundWarning
              ? `已扫码（账号 ${st.accountId ?? slot ?? ''}）。${st.boundWarning}`
              : `绑定成功：账号 ${st.accountId ?? slot ?? ''}。已尝试拉起进程 weixin:${st.accountId ?? slot ?? ''}。`,
          });
          await refresh();
        } else {
          setMsg({ type: 'error', text: st.message || '扫码超时或未确认，请重新发起二维码' });
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setScanning(false);
        setMsg({ type: 'error', text: `扫码状态查询失败：${e instanceof Error ? e.message : String(e)}` });
      }
    } catch (e) {
      setScanning(false);
      setMsg({ type: 'error', text: `发起扫码失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const cancelScan = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setScanning(false);
    setQr(null);
    setMsg(null);
  };

  const reloadChannel = async () => {
    setMsg({ type: 'info', text: '正在重启微信渠道…' });
    try {
      await wx.reload(status?.bindAccountId);
      setMsg({ type: 'success', text: '微信渠道已重启' });
      notify.success('微信渠道已重启');
      await refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `重启失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const unbind = async () => {
    const slot = status?.bindAccountId;
    const ok = await confirmAsync({
      title: '取消绑定微信机器人？',
      content: '将停止该账号的微信进程并删除本机登录态，之后需要重新扫码才能收发消息。任务空间不会删除。',
      okText: '取消绑定',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    setUnbinding(true);
    setMsg({ type: 'info', text: '正在取消绑定…' });
    try {
      await wx.unbind(slot);
      cancelScan();
      setMsg({ type: 'success', text: '已取消绑定' });
      notify.success('已取消微信绑定');
      await refresh();
    } catch (e) {
      if (!props.onAuthError(e)) {
        setMsg({ type: 'error', text: `取消绑定失败：${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      setUnbinding(false);
    }
  };

  const slot = status?.bindAccountId || props.username || '';
  const bound = !!status?.configured;
  const running = !!status?.processRunning;
  const stepCurrent = !slot ? 0 : !bound ? 1 : 2;

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

          <Steps
            size="small"
            current={stepCurrent}
            style={{ marginBottom: 18 }}
            items={[
              {
                title: '登录账号',
                description: slot ? <code className="code-cell">{slot}</code> : '请先登录后台',
              },
              {
                title: '扫码绑定',
                description: bound ? '已绑定' : '用机器人微信号扫码',
              },
              {
                title: '拉起进程',
                description: bound ? (running ? '运行中' : '未运行，点重启') : '绑定成功后自动启动',
              },
            ]}
          />

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message="微信进程按登录账号维护：注册或登录 → 本页扫码绑定 → 自动重启对应 weixin:<用户名>。pnpm restart:all 只拉起已绑定账号的实例。"
          />

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
                key: 'slot',
                label: '账号槽',
                children: <code className="code-cell">{status?.bindAccountId || status?.activeAccountId || '—'}</code>,
              },
              {
                key: 'proc',
                label: '微信进程',
                children: status ? (
                  <Tag color={status.processRunning ? 'success' : 'default'} style={{ borderRadius: 999 }}>
                    {status.processId ?? 'weixin'} · {status.processRunning ? '运行中' : '未运行'}
                  </Tag>
                ) : (
                  <Spin size="small" />
                ),
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
            <Button type="primary" loading={scanning} onClick={() => void startScan(status?.bindAccountId)}>
              {scanning ? '等待扫码…' : status?.configured ? '重新绑定' : '绑定微信机器人'}
            </Button>
            {scanning ? <Button onClick={cancelScan}>取消</Button> : null}
            {status?.configured ? (
              <Button icon={<ReloadOutlined />} onClick={() => void reloadChannel()} disabled={unbinding}>
                重启渠道
              </Button>
            ) : null}
            {status?.configured ? (
              <Button danger loading={unbinding} disabled={scanning} onClick={() => void unbind()}>
                取消绑定
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
