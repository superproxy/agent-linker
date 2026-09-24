import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { Alert, Button, Card, Input, Space, Switch, Typography } from 'antd';

import { ReloadOutlined } from '@ant-design/icons';

import { ChannelGatewayLogsClient } from '../api';

import { processApiBase } from '../lib/constants';



export function ChannelGatewayLogPanel(props: { token: string; title?: string; hint?: string }) {

  const client = useMemo(() => new ChannelGatewayLogsClient(processApiBase(), () => props.token), [props.token]);

  const [content, setContent] = useState('');

  const [gatewayTrace, setGatewayTrace] = useState('');

  const [traceHint, setTraceHint] = useState('');

  const [source, setSource] = useState<'auto' | 'pm' | 'push'>('auto');

  const [sourceMode, setSourceMode] = useState<'auto' | 'pm' | 'push'>('auto');

  const [filter, setFilter] = useState('step=');

  const [busy, setBusy] = useState(false);

  const [err, setErr] = useState<string | null>(null);

  const [auto, setAuto] = useState(true);

  const [reportedAt, setReportedAt] = useState<number | null>(null);

  const [running, setRunning] = useState(false);



  const refresh = useCallback(async () => {

    setBusy(true);

    try {

      const r = await client.get(400, sourceMode);

      setContent(r.content);

      setGatewayTrace(r.gatewayTrace ?? '');

      setTraceHint(r.traceHint ?? '');

      setSource(r.source);

      setReportedAt(r.reportedAt);

      setRunning(r.channelsRunning);

      setErr(null);

    } catch (e) {

      setErr(e instanceof Error ? e.message : String(e));

    } finally {

      setBusy(false);

    }

  }, [client, sourceMode]);



  useEffect(() => {

    void refresh();

  }, [refresh]);



  useEffect(() => {

    if (!auto) return;

    const t = setInterval(() => void refresh(), 5000);

    return () => clearInterval(t);

  }, [auto, refresh]);



  const applyFilter = (text: string) => {

    const f = filter.trim().toLowerCase();

    if (!f) return text;

    return text

      .split('\n')

      .filter((line) => line.toLowerCase().includes(f))

      .join('\n');

  };



  const displayChannels = useMemo(() => applyFilter(content), [content, filter]);

  const displayGateway = useMemo(() => applyFilter(gatewayTrace), [gatewayTrace, filter]);



  const preStyle: CSSProperties = {

    margin: 0,

    maxHeight: 280,

    overflow: 'auto',

    padding: 12,

    fontSize: 12,

    lineHeight: 1.45,

    background: 'var(--ant-color-fill-quaternary, #f5f5f5)',

    borderRadius: 8,

    whiteSpace: 'pre-wrap',

    wordBreak: 'break-all',

  };



  return (

    <Card

      title={props.title ?? 'channels 远程日志'}

      style={{ marginTop: 16 }}

      extra={

        <Space>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>

            来源：{source === 'pm' ? '本地 pm 文件' : source === 'push' ? '进程推送' : '自动'}

            {reportedAt ? ` · 推送 ${new Date(reportedAt).toLocaleTimeString()}` : ''}

            {running ? ' · 运行中' : ' · 已停止'}

          </Typography.Text>

          <Switch checked={auto} onChange={setAuto} checkedChildren="自动刷新" unCheckedChildren="手动" />

          <Button icon={<ReloadOutlined />} loading={busy} onClick={() => void refresh()}>

            刷新

          </Button>

        </Space>

      }

    >

      {props.hint ? (

        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 8 }}>

          {props.hint}

        </Typography.Paragraph>

      ) : null}

      {traceHint ? (

        <Alert type="info" showIcon message="端到端追踪" description={traceHint} style={{ marginBottom: 8 }} />

      ) : null}

      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} /> : null}

      <Space wrap style={{ marginBottom: 8 }}>

        <Typography.Text type="secondary">日志来源</Typography.Text>

        <Button size="small" type={sourceMode === 'auto' ? 'primary' : 'default'} onClick={() => setSourceMode('auto')}>

          自动

        </Button>

        <Button size="small" type={sourceMode === 'pm' ? 'primary' : 'default'} onClick={() => setSourceMode('pm')}>

          本地文件

        </Button>

        <Button size="small" type={sourceMode === 'push' ? 'primary' : 'default'} onClick={() => setSourceMode('push')}>

          远程推送

        </Button>

      </Space>

      <Input

        allowClear

        placeholder="过滤（默认 step= 只看追踪行；可改 traceId、wecom、401）"

        value={filter}

        onChange={(e) => setFilter(e.target.value)}

        style={{ marginBottom: 8 }}

      />

      <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>

        channel-gateway（入站 → token → /v1 → 回执）

      </Typography.Text>

      <pre style={preStyle}>

        {displayChannels.trim() ||

          '（暂无 channels 日志；确认 channels 已启动。追踪行形如 [trace] step=channels.inbound …）'}

      </pre>

      <Typography.Text strong style={{ display: 'block', margin: '12px 0 4px' }}>

        gateway（收 /v1 → 路由 → agent → 完成）

      </Typography.Text>

      <pre style={preStyle}>

        {displayGateway.trim() ||

          '（暂无 gateway 追踪；向企微/微信发一条消息后应出现 step=gateway.v1.recv，且 traceId 与 channels 侧一致）'}

      </pre>

    </Card>

  );

}


