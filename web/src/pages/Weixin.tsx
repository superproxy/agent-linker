import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Descriptions, Row, Space, Spin, Steps, Switch, Tag, Typography } from 'antd';
import { CloudServerOutlined, QrcodeOutlined, ReloadOutlined } from '@ant-design/icons';
import { PmClient, WeixinChannelConfigClient, WeixinClient, type WeixinChannelConfig, type WeixinStatus } from '../api';
import { processApiBase } from '../lib/constants';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';

export function WeixinPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onStatus?: (s: WeixinStatus | null) => void;
  username?: string;
  isAdmin?: boolean;
}) {
  const wx = useMemo(() => new WeixinClient(props.base, () => props.token), [props.base, props.token]);
  const apiBase = processApiBase();
  const wxCg = useMemo(
    () => (props.isAdmin ? new WeixinChannelConfigClient(apiBase, () => props.token) : null),
    [apiBase, props.token, props.isAdmin],
  );
  const pm = useMemo(() => (props.isAdmin ? new PmClient(apiBase, () => props.token) : null), [apiBase, props.token, props.isAdmin]);
  const { tick } = useRefreshTick();
  const [status, setStatus] = useState<WeixinStatus | null>(null);
  const [cgCfg, setCgCfg] = useState<WeixinChannelConfig | null>(null);
  const [cgBusy, setCgBusy] = useState(false);
  const [usePlugin, setUsePlugin] = useState(false);
  const [cgEnabled, setCgEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [msg, setMsg] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [forceRebind, setForceRebind] = useState(false);
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
    if (wxCg) {
      try {
        const c = await wxCg.get();
        setCgCfg(c);
        setUsePlugin(c.channelGateway.weixinPlugin);
        setCgEnabled(c.channelGateway.enabled);
      } catch {
        /* 非管理员或 channels 未配置时忽略 */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wx, wxCg, tick]);

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
      setMsg({ type: 'info', text: slot ? `请扫码绑定账号槽 ${slot}（绑定后将重启 channels 进程）` : '请用手机微信扫一扫完成绑定' });
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      let shown = r.qrContent;
      const poll = window.setInterval(() => {
        if (!r.sessionKey || ac.signal.aborted) return;
        void wx.qrCurrent(r.sessionKey, ac.signal).then((cur) => {
          if (ac.signal.aborted || !cur.qrDataUrl || !cur.qrContent || cur.qrContent === shown) return;
          shown = cur.qrContent;
          setQr(cur.qrDataUrl);
          setMsg({ type: 'info', text: '二维码已更新，请扫描页面上这一张，不要扫旧的。' });
        }).catch(() => {});
      }, 2000);
      try {
        const st = await wx.qrStatus(r.sessionKey, 120_000, slot, ac.signal, props.isAdmin && forceRebind);
        if (ac.signal.aborted) return;
        setScanning(false);
        if (st.connected) {
          setMsg({
            type: st.boundWarning ? 'info' : 'success',
            text: st.boundWarning
              ? `已扫码（账号 ${st.accountId ?? slot ?? ''}）。${st.boundWarning}`
              : st.alreadyBound
                ? st.message || '这个微信机器人已经绑定过，沿用本机登录态。'
                : `绑定成功：账号 ${st.accountId ?? slot ?? ''}。已尝试重启 channels 进程。`,
          });
          await refresh();
        } else {
          setMsg({ type: 'error', text: st.message || '扫码超时或未确认，请重新发起二维码' });
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setScanning(false);
        setMsg({ type: 'error', text: `扫码状态查询失败：${e instanceof Error ? e.message : String(e)}` });
      } finally {
        window.clearInterval(poll);
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
      content:
        '会停掉该账号的微信进程，并删除本机登录态。若没有其他用户的账号文件，一并清掉残留的 *-im-bot 登录态，避免页面显示未绑定却扫码提示已绑定。任务空间不会删除。',
      okText: status?.configured ? '取消绑定' : '清空登录态',
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

  const startPluginWeixin = async (restart = true) => {
    if (!wxCg) return;
    setCgBusy(true);
    try {
      await wxCg.save({
        channelGateway: {
          enabled: true,
          weixin: true,
          weixinPlugin: usePlugin,
        },
        restart,
        startOnly: !restart,
      });
      notify.success(restart ? '已保存并重启 channels（插件微信）' : '已启动 channels');
      await refresh();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCgBusy(false);
    }
  };

  const pmAct = async (op: 'start' | 'restart' | 'stop') => {
    if (!pm) return;
    setCgBusy(true);
    try {
      if (op === 'start') await pm.start(['channels']);
      else if (op === 'stop') await pm.stop(['channels']);
      else await pm.restart(['channels']);
      await refresh();
      notify.success('操作完成');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCgBusy(false);
    }
  };

  const slot = status?.bindAccountId || props.username || '';
  const bound = !!status?.configured;
  const channelsRunning = cgCfg?.status.channelsRunning ?? false;
  const channelGatewayOn = cgCfg?.status.channelGatewayEnabled ?? false;
  const running = channelGatewayOn ? channelsRunning : !!status?.processRunning;
  const stepCurrent = !slot ? 0 : !bound ? 1 : 2;

  return (
    <Row gutter={[16, 16]}>
      {props.isAdmin && wxCg ? (
        <Col xs={24}>
          <Card
            title={
              <Space>
                <CloudServerOutlined />
                <span>插件微信 · channel-gateway</span>
                {channelsRunning ? <Tag color="success">channels 运行中</Tag> : <Tag>channels 已停止</Tag>}
              </Space>
            }
            style={{ marginBottom: 0 }}
          >
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              在 channels 进程内托管个人微信：默认 <code>weixin-bot</code>（ilink）；开启「OpenClaw 插件收发」则加载{' '}
              <code>@tencent-weixin/openclaw-weixin</code>（需先在本页扫码绑定，并执行 <code>pnpm setup:channels</code>）。
            </Typography.Paragraph>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space wrap>
                <span>启用 channel-gateway</span>
                <Switch checked={cgEnabled} onChange={setCgEnabled} disabled={cgBusy} />
                <span style={{ marginLeft: 16 }}>OpenClaw 插件收发</span>
                <Switch checked={usePlugin} onChange={setUsePlugin} disabled={cgBusy} />
              </Space>
              <Space wrap>
                <Button
                  type="primary"
                  loading={cgBusy}
                  onClick={() =>
                    void wxCg
                      .save({
                        channelGateway: { enabled: cgEnabled, weixin: true, weixinPlugin: usePlugin },
                        restart: true,
                      })
                      .then(() => refresh())
                      .then(() => notify.success('已保存'))
                      .catch((e) => notify.error(e instanceof Error ? e.message : String(e)))
                      .finally(() => setCgBusy(false))
                  }
                >
                  保存并重启 channels
                </Button>
                <Button loading={cgBusy} disabled={!usePlugin && !cgEnabled} onClick={() => void startPluginWeixin(true)}>
                  启动插件微信
                </Button>
                <Button disabled={cgBusy || channelsRunning} onClick={() => void pmAct('start')}>
                  启动 channels
                </Button>
                <Button icon={<ReloadOutlined />} disabled={cgBusy || !channelsRunning} onClick={() => void pmAct('restart')}>
                  重启 channels
                </Button>
                <Button danger disabled={cgBusy || !channelsRunning} onClick={() => void pmAct('stop')}>
                  停止 channels
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>
      ) : null}
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
            message="个人微信统一由 channel-gateway（channels 进程）托管：扫码绑定后会写入 channels.yaml 并重启 channels。收发可选 weixin-bot（ilink）或 OpenClaw 插件（见上方卡片）。"
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

          {status && !status.configured && (status.savedPlugins?.length ?? 0) > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 14 }}
              message="本机还留着机器人登录文件，但当前账号没有绑定关系。重启不会使用这份旧配置。一个账号只能绑一个微信，请重新绑定。"
            />
          ) : null}

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

          {props.isAdmin ? (
            <div style={{ marginTop: 12 }}>
              <Checkbox checked={forceRebind} disabled={scanning} onChange={(e) => setForceRebind(e.target.checked)}>
                强制换绑（解除原登录用户对该微信的绑定，仅管理员）
              </Checkbox>
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
            <Button danger loading={unbinding} disabled={scanning || !slot} onClick={() => void unbind()}>
              {status?.configured ? '取消绑定' : '清空登录态'}
            </Button>
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
