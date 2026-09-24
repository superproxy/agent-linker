import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Input, Radio, Space, Switch, Tag, Typography } from 'antd';
import { CloudServerOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { PmClient, WecomConfigClient, type WecomChannelConfig } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { processApiBase } from '../lib/constants';
import { ChannelGatewayLogPanel } from '../components/channel-gateway-log-panel';

type FormValues = {
  enabled: boolean;
  botId: string;
  secret: string;
  enableChannelGateway: boolean;
  connectionMode: 'websocket' | 'webhook';
};

export function WecomPage(props: { token: string; onAuthError: AuthErrorHandler; isAdmin?: boolean }) {
  const base = processApiBase();
  const client = useMemo(() => new WecomConfigClient(base, () => props.token), [base, props.token]);
  const pm = useMemo(
    () => (props.isAdmin ? new PmClient(base, () => props.token) : null),
    [base, props.token, props.isAdmin],
  );
  const { tick } = useRefreshTick();
  const [form] = Form.useForm<FormValues>();
  const [cfg, setCfg] = useState<WecomChannelConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await client.get();
      setCfg(c);
      setErr(null);
      form.setFieldsValue({
        enabled: c.enabled,
        botId: c.botId,
        secret: '',
        enableChannelGateway: c.channelGateway.enabled,
        connectionMode: c.connectionMode === 'webhook' ? 'webhook' : 'websocket',
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
        botId: values.botId.trim(),
        secret: values.secret.trim() || undefined,
        connectionMode: values.connectionMode,
        restart,
        channelGateway: {
          enabled: values.enableChannelGateway || values.enabled,
          wecom: values.enabled,
        },
      });
      setCfg(r);
      form.setFieldValue('secret', '');
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

  return (
    <div className="page-stack">
      <Typography.Title level={4} style={{ margin: 0 }}>
        企业微信
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        通过 OpenClaw 插件接入企微。首次部署请执行 <code>pnpm setup:channels</code> 安装并校验插件，再启用 channel-gateway。WebSocket 一般无需公网 URL；Webhook 需在企微后台填回调（并开启 exposePluginRoutes）。
      </Typography.Paragraph>

      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}

      {cfg?.taskOwnerUsername ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`任务空间归属：${cfg.taskOwnerUsername}`}
          description="保存配置时会绑定到当前登录用户（与微信绑定账号槽一致）；企微消息 /task 与任务目录使用该用户名。"
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
          <Alert type="warning" showIcon style={{ marginTop: 12 }} message="channels 已运行，尚未收到运行态推送（检查 gateway token 与 pushStatusToGateway）" />
        ) : null}
        {cfg?.connectionMode === 'websocket' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message="智能机器人 · WebSocket 长连接（推荐）"
            description={
              <>
                对应企微帮助中心「方式3：应用内授权」：在管理后台创建 API 智能机器人并完成应用内授权后，channels 进程由{' '}
                <code>@wecom/wecom-openclaw-plugin</code> 主动连接{' '}
                <code>wss://openws.work.weixin.qq.com</code>，一般<strong>无需</strong>公网回调 URL。详见{' '}
                <a href="https://developer.work.weixin.qq.com/document/path/101463" target="_blank" rel="noreferrer">
                  开发者文档 · 智能机器人长连接
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
            message="Bot Webhook / Agent 回调 URL（任选其一）"
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

      <Card title="OpenClaw 企微配置">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="enableChannelGateway" label="启用 channel-gateway" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="enabled" label="启用企微渠道" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="connectionMode" label="Bot 连接方式">
            <Radio.Group>
              <Radio.Button value="websocket">WebSocket 长连接（应用内授权）</Radio.Button>
              <Radio.Button value="webhook">HTTP Webhook</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="botId" label="botId" rules={[{ required: true, message: '请填写 botId' }]}>
            <Input placeholder="API 智能机器人 Bot ID" spellCheck={false} />
          </Form.Item>
          <Form.Item
            name="secret"
            label="secret"
            extra={
              cfg?.secret.configured
                ? `已配置（${cfg.secret.preview}），留空则不修改`
                : '首次启用必填'
            }
          >
            <Input.Password placeholder="企微 secret" autoComplete="new-password" spellCheck={false} />
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

      {props.isAdmin ? (
        <ChannelGatewayLogPanel
          token={props.token}
          title="channels 远程日志（企微调试）"
          hint="端到端追踪：channels 侧 step=channels.*（入站/token/v1/回执），gateway 侧 step=gateway.*；用同一 traceId 串起来。重启 gateway + channels 后生效。"
        />
      ) : null}
    </div>
  );
}
