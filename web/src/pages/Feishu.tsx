import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Input, Radio, Space, Switch, Tag, Typography } from 'antd';
import { CloudServerOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { FeishuConfigClient, PmClient, type FeishuChannelConfig } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { processApiBase } from '../lib/constants';
import { ChannelGatewayLogPanel } from '../components/channel-gateway-log-panel';

type FormValues = {
  enabled: boolean;
  appId: string;
  appSecret: string;
  enableChannelGateway: boolean;
  connectionMode: 'websocket' | 'webhook';
  pluginPackage: string;
  verificationToken: string;
  encryptKey: string;
};

export function FeishuPage(props: { token: string; onAuthError: AuthErrorHandler; isAdmin?: boolean }) {
  const base = processApiBase();
  const client = useMemo(() => new FeishuConfigClient(base, () => props.token), [base, props.token]);
  const pm = useMemo(
    () => (props.isAdmin ? new PmClient(base, () => props.token) : null),
    [base, props.token, props.isAdmin],
  );
  const { tick } = useRefreshTick();
  const [form] = Form.useForm<FormValues>();
  const [cfg, setCfg] = useState<FeishuChannelConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await client.get();
      setCfg(c);
      setErr(null);
      form.setFieldsValue({
        enabled: c.enabled,
        appId: c.appId,
        appSecret: '',
        enableChannelGateway: c.channelGateway.enabled,
        connectionMode: c.connectionMode === 'webhook' ? 'webhook' : 'websocket',
        pluginPackage: c.pluginPackage,
        verificationToken: '',
        encryptKey: '',
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [client, form, tick]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (restart = true) => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const r = await client.save({
        enabled: values.enabled,
        appId: values.appId.trim(),
        appSecret: values.appSecret.trim() || undefined,
        connectionMode: values.connectionMode,
        pluginPackage: values.pluginPackage.trim(),
        verificationToken: values.verificationToken.trim() || undefined,
        encryptKey: values.encryptKey.trim() || undefined,
        restart,
        channelGateway: {
          enabled: values.enableChannelGateway || values.enabled,
          feishu: values.enabled,
        },
      });
      setCfg(r);
      form.setFieldsValue({ appSecret: '', verificationToken: '', encryptKey: '' });
      notify.success(restart ? '已保存并重启 channels 进程' : '已保存');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pmAct = async (op: 'start' | 'restart' | 'stop') => {
    if (!pm) return;
    setBusy(true);
    try {
      if (op === 'start') await pm.start(['channels']);
      else if (op === 'stop') await pm.stop(['channels']);
      else await pm.restart(['channels']);
      await refresh();
      notify.success('操作完成');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = cfg?.status.channelsRunning ?? false;
  const webhookMode = cfg?.connectionMode === 'webhook';

  return (
    <div className="page-stack">
      <Typography.Title level={4} style={{ margin: 0 }}>
        飞书
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        通过 OpenClaw 插件接入飞书/Lark。首次部署请在本机执行 <code>pnpm setup:channels</code> 安装并校验插件，再在此页保存配置。
      </Typography.Paragraph>

      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}

      {cfg?.taskOwnerUsername ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`任务空间归属：${cfg.taskOwnerUsername}`}
          description="保存配置时会绑定到当前登录用户；飞书消息的任务路由与 ct_ 使用该用户名。"
        />
      ) : null}

      {props.isAdmin ? (
      <Card
        title={
          <Space>
            <CloudServerOutlined />
            <span>渠道进程</span>
            {running ? <Tag color="success">channels 运行中</Tag> : <Tag>channels 已停止</Tag>}
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space wrap>
          <Button disabled={busy || running} onClick={() => void pmAct('start')}>
            启动 channels
          </Button>
          <Button icon={<ReloadOutlined />} disabled={busy || !running} onClick={() => void pmAct('restart')}>
            重启 channels
          </Button>
          <Button danger disabled={busy || !running} onClick={() => void pmAct('stop')}>
            停止 channels
          </Button>
        </Space>
        {cfg?.status.runtimeReport ? (
          <Alert
            type="success"
            showIcon
            style={{ marginTop: 12 }}
            message={`运行态已推送到 gateway（${new Date(cfg.status.runtimeReport.reportedAt).toLocaleString()}）`}
            description={
              <>
                微信 bot 数：{cfg.status.runtimeReport.weixinBotCount}；插件账号：
                {cfg.status.runtimeReport.pluginAccounts.length === 0
                  ? ' 无'
                  : cfg.status.runtimeReport.pluginAccounts.map((a) => (
                      <span key={a.key}>
                        {' '}
                        <code>{a.key}</code>({a.running ? '运行' : '停止'}
                        {a.lastError ? ` · ${a.lastError}` : ''})
                      </span>
                    ))}
              </>
            }
          />
        ) : cfg?.status.channelsRunning ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="channels 已运行，尚未收到运行态推送（检查 gateway token 与 pushStatusToGateway）"
          />
        ) : null}
        {cfg?.connectionMode === 'websocket' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="WebSocket 长连接（推荐）"
            description={
              <>
                插件默认出站连接飞书事件流，一般<strong>无需</strong>公网回调；需在飞书开放平台配置应用权限与事件订阅。详见{' '}
                <a href="https://docs.openclaw.ai/channels/feishu" target="_blank" rel="noreferrer">
                  OpenClaw · Feishu
                </a>
                。
              </>
            }
          />
        ) : cfg?.status.callbackUrls?.length ? (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="Webhook 事件 URL（需在 channels.yaml 开启 exposePluginRoutes 并在飞书后台填写）"
            description={
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {cfg.status.callbackUrls.map((u) => (
                  <li key={u}>
                    <code>{u}</code>
                  </li>
                ))}
              </ul>
            }
          />
        ) : webhookMode ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="Webhook 模式需 channelGateway.http.exposePluginRoutes=true 并配置 verificationToken / encryptKey"
          />
        ) : null}
      </Card>
      ) : cfg ? (
        <Alert
          type={running ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={running ? 'channels 运行中' : 'channels 未运行；点「保存并重启 channels」即可拉起'}
        />
      ) : null}

      <Card title="OpenClaw 飞书配置">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="enableChannelGateway" label="启用 channel-gateway" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="enabled" label="启用飞书渠道" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="pluginPackage" label="插件 npm 包名" rules={[{ required: true, message: '请填写插件包名' }]}>
            <Input placeholder="@openclaw/feishu" spellCheck={false} />
          </Form.Item>
          <Form.Item name="connectionMode" label="连接方式">
            <Radio.Group>
              <Radio.Button value="websocket">WebSocket 长连接</Radio.Button>
              <Radio.Button value="webhook">HTTP Webhook</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="appId" label="appId" rules={[{ required: true, message: '请填写 appId' }]}>
            <Input placeholder="飞书开放平台 App ID" spellCheck={false} />
          </Form.Item>
          <Form.Item
            name="appSecret"
            label="appSecret"
            extra={
              cfg?.appSecret.configured
                ? `已配置（${cfg.appSecret.preview}），留空则不修改`
                : '首次启用必填'
            }
          >
            <Input.Password placeholder="App Secret" autoComplete="new-password" spellCheck={false} />
          </Form.Item>
          <Form.Item name="verificationToken" label="verificationToken（Webhook 可选）" extra="留空则不修改 yaml 中已有值">
            <Input.Password placeholder="Webhook 校验 Token" autoComplete="new-password" spellCheck={false} />
          </Form.Item>
          <Form.Item name="encryptKey" label="encryptKey（Webhook 可选）" extra="留空则不修改 yaml 中已有值">
            <Input.Password placeholder="事件加密 Key" autoComplete="new-password" spellCheck={false} />
          </Form.Item>
          <Space>
            <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={() => void save(true)}>
              保存并重启 channels
            </Button>
            <Button loading={busy} onClick={() => void save(false)}>
              仅保存
            </Button>
          </Space>
        </Form>
      </Card>

      {props.isAdmin ? <ChannelGatewayLogPanel token={props.token} title="channels 远程日志（飞书调试）" /> : null}
    </div>
  );
}
