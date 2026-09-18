import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, Input, Modal, Radio, Row, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudServerOutlined,
  ControlOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  PmClient,
  type ChildGatewayId,
  type ChildGatewayTargetInfo,
  type PmProcess,
} from '../api';
import { useRefreshTick } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { processApiBase, type GatewayProfile } from '../lib/constants';
import {
  GatewayProfilesList,
  ProfileEditModal,
  useGatewayProfiles,
} from '../components/GatewayProfiles';

interface MountFormValues {
  scope: 'local' | 'remote';
  url: string;
  token: string;
}

function MountModal(props: {
  open: boolean;
  id: ChildGatewayId;
  current: ChildGatewayTargetInfo | undefined;
  profiles: GatewayProfile[];
  onCancel: () => void;
  onSubmit: (values: { url: string; token: string }) => Promise<void>;
}) {
  const [form] = Form.useForm<MountFormValues>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    const remote = !!props.current && !props.current.local;
    form.setFieldsValue({
      scope: remote ? 'remote' : 'local',
      url: props.current?.url ?? '',
      token: '',
    });
  }, [props.open, props.current, form]);

  const scope = Form.useWatch('scope', form);

  const applyProfile = (profileId: string) => {
    const p = props.profiles.find((x) => x.id === profileId);
    if (!p) return;
    form.setFieldsValue({ scope: 'remote', url: p.url, token: p.token ?? '' });
  };

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      await props.onSubmit(
        values.scope === 'remote'
          ? { url: values.url.trim().replace(/\/+$/, ''), token: values.token.trim() }
          : { url: '', token: '' },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title={`设置${props.id === 'weixin' ? '微信 bot' : 'node 节点'}挂载的网关`}
      okText="保存并重启"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={props.onCancel}
      onOk={() => void submit()}
      destroyOnClose
      maskClosable={false}
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 12 }}>
        {props.profiles.length > 0 ? (
          <Form.Item label="从已保存的远程网关选择">
            <Select
              allowClear
              placeholder="选择后自动带入地址与 Token"
              options={props.profiles.map((p) => ({ value: p.id, label: `${p.name}（${p.url}）` }))}
              onChange={(v) => v && applyProfile(v)}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="scope" label="挂载目标" rules={[{ required: true }]}>
          <Radio.Group>
            <Radio.Button value="local">本机网关</Radio.Button>
            <Radio.Button value="remote">远程网关</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {scope === 'remote' ? (
          <>
            <Form.Item
              name="url"
              label="网关地址"
              rules={[
                { required: true, whitespace: true, message: '请输入远程网关地址' },
                {
                  validator: (_, v: string) =>
                    /^https?:\/\/.+/.test((v ?? '').trim())
                      ? Promise.resolve()
                      : Promise.reject(new Error('需以 http:// 或 https:// 开头')),
                },
              ]}
            >
              <Input placeholder="http://192.168.1.10:8787" spellCheck={false} />
            </Form.Item>
            <Form.Item name="token" label="回连 Token（可选）" tooltip="远程网关开启鉴权时填写其 gateway token">
              <Input.Password placeholder="远程网关免鉴权可留空" spellCheck={false} autoComplete="new-password" />
            </Form.Item>
          </>
        ) : null}
        <Alert
          type="info"
          showIcon
          message="保存后会自动重启该进程，重启后即连接到所选网关；进程重启期间对应服务短暂中断。"
        />
      </Form>
    </Modal>
  );
}

function ChildGatewayMounts(props: { client: PmClient }) {
  const { tick } = useRefreshTick();
  const [targets, setTargets] = useState<Record<ChildGatewayId, ChildGatewayTargetInfo> | null>(null);
  const { profiles, upsert, remove } = useGatewayProfiles();
  const [err, setErr] = useState<string | null>(null);
  const [mountFor, setMountFor] = useState<ChildGatewayId | null>(null);
  const [profileModal, setProfileModal] = useState<{ open: boolean; editing: GatewayProfile | null }>({
    open: false,
    editing: null,
  });

  const refresh = useCallback(async () => {
    try {
      setTargets(await props.client.gatewayTargets());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.client, tick]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitMount = async (id: ChildGatewayId, values: { url: string; token: string }) => {
    try {
      const r = await props.client.setGatewayTarget(id, values.url, values.token);
      setTargets(r.targets);
      setMountFor(null);
      notify.success(`已保存，${id === 'weixin' ? '微信 bot' : 'node'} 已重启`);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const mountColumns = (): ColumnsType<{ id: ChildGatewayId; label: string }> => [
    {
      title: '进程',
      dataIndex: 'label',
      key: 'label',
      render: (label: string) => <code className="code-cell" style={{ fontSize: 13 }}>{label}</code>,
    },
    {
      title: '当前挂载',
      key: 'target',
      render: (_, row) => {
        const t = targets?.[row.id];
        if (!t) return <span className="sub-muted">—</span>;
        if (t.local) {
          return (
            <Space size={6}>
              <Tag color="green" style={{ borderRadius: 999 }}>本机网关</Tag>
            </Space>
          );
        }
        return (
          <Space size={6} wrap>
            <Tag color="orange" style={{ borderRadius: 999 }}>远程</Tag>
            <code className="code-cell">{t.url}</code>
            {t.tokenConfigured ? <Tag style={{ borderRadius: 999 }}>Token 已配置</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      render: (_, row) => (
        <Button size="small" type="primary" ghost onClick={() => setMountFor(row.id)}>
          设置挂载
        </Button>
      ),
    },
  ];

  return (
    <Card
      bordered
      title={
        <Space>
          <CloudServerOutlined />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>本机进程挂载网关</span>
        </Space>
      }
    >
      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="本机的微信 bot 与 node 进程可分别挂载到本机或远程网关；保存后自动重启对应进程。远程网关清单也可在「远程 · 网关」维护。"
      />
      <Table
        rowKey="id"
        size="middle"
        columns={mountColumns()}
        dataSource={[
          { id: 'weixin' as ChildGatewayId, label: '微信 bot' },
          { id: 'node' as ChildGatewayId, label: 'node 节点' },
        ]}
        pagination={false}
        loading={targets === null}
      />
      <div className="sub-muted" style={{ margin: '16px 0 8px' }}>远程网关清单（仅保存在当前浏览器，供挂载时选择）</div>
      <GatewayProfilesList
        profiles={profiles}
        onEdit={(p) => setProfileModal({ open: true, editing: p })}
        onRemove={(p) => void remove(p)}
        onAdd={() => setProfileModal({ open: true, editing: null })}
      />
      <MountModal
        open={mountFor !== null}
        id={mountFor ?? 'weixin'}
        current={mountFor ? targets?.[mountFor] : undefined}
        profiles={profiles}
        onCancel={() => setMountFor(null)}
        onSubmit={(values) => (mountFor ? submitMount(mountFor, values) : Promise.resolve())}
      />
      <ProfileEditModal
        open={profileModal.open}
        profile={profileModal.editing}
        onCancel={() => setProfileModal({ open: false, editing: null })}
        onSubmit={(values) => {
          upsert(profileModal.editing, values);
          setProfileModal({ open: false, editing: null });
        }}
      />
    </Card>
  );
}

function waitGatewayBack(client: PmClient, timeoutMs = 40_000): Promise<void> {
  const start = Date.now();
  return (async function loop(): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        await client.systemInfo();
        return;
      } catch {
        if (Date.now() - start > timeoutMs) return;
      }
    }
  })();
}

function ProcessTable(props: { client: PmClient }) {
  const { tick } = useRefreshTick();
  const [procs, setProcs] = useState<PmProcess[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restartingGw, setRestartingGw] = useState(false);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [logBusy, setLogBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProcs(await props.client.status());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.client, tick]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (id: string, op: 'start' | 'stop' | 'restart') => {
    if (op === 'restart' && id === 'gateway') {
      const ok = await confirmAsync({
        title: '确认重启网关？',
        content: '期间网页与 OpenAI 接口会短暂中断（约数秒），微信/节点会自动重连。',
        okText: '重启网关',
      });
      if (!ok) return;
    }
    setBusyId(`${id}:${op}`);
    setErr(null);
    try {
      if (op === 'start') setProcs(await props.client.start([id]));
      else if (op === 'stop') setProcs(await props.client.stop([id]));
      else {
        const r = await props.client.restart([id]);
        if (r.gateway) {
          setRestartingGw(true);
          notify.info('网关重启中，等待恢复…');
          await waitGatewayBack(props.client);
          setRestartingGw(false);
          notify.success('网关已恢复');
        }
        if (r.processes) setProcs(r.processes);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRestartingGw(false);
    } finally {
      setBusyId(null);
    }
  };

  const toggleLog = async (id: string) => {
    if (logFor === id) {
      setLogFor(null);
      return;
    }
    setLogFor(id);
    setLogBusy(true);
    try {
      setLogText(await props.client.logs(id, 200));
    } catch (e) {
      setLogText(`读取日志失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLogBusy(false);
    }
  };

  const columns: ColumnsType<PmProcess> = [
    {
      title: '进程',
      dataIndex: 'label',
      key: 'label',
      render: (label: string, p) => (
        <Space>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: p.running ? '#22c55e' : '#ef4444',
              boxShadow: p.running ? '0 0 6px rgba(34,197,94,0.6)' : 'none',
              display: 'inline-block',
            }}
          />
          <code className="code-cell" style={{ fontSize: 13 }}>{label}</code>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 180,
      render: (_, p) =>
        p.running ? (
          <Tag color="success" style={{ borderRadius: 999 }}>
            运行中{p.pid ? ` · pid ${p.pid}` : ''}
          </Tag>
        ) : (
          <Tag style={{ borderRadius: 999 }}>已停止</Tag>
        ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 300,
      render: (_, p) => {
        const busy = (bid: string) => busyId === bid;
        return (
          <Space size={6} wrap>
            {p.id === 'gateway' ? (
              <Button size="small" icon={<ReloadOutlined />} disabled={busyId?.startsWith('gateway:') || restartingGw} onClick={() => void act(p.id, 'restart')}>
                重启
              </Button>
            ) : (
              <>
                <Button size="small" disabled={busy(`${p.id}:start`) || p.running} onClick={() => void act(p.id, 'start')}>
                  启动
                </Button>
                <Button size="small" danger disabled={busy(`${p.id}:stop`) || !p.running} onClick={() => void act(p.id, 'stop')}>
                  停止
                </Button>
                <Button size="small" icon={<ReloadOutlined />} disabled={busy(`${p.id}:restart`)} onClick={() => void act(p.id, 'restart')}>
                  重启
                </Button>
              </>
            )}
            <Button size="small" icon={<FileTextOutlined />} onClick={() => void toggleLog(p.id)}>
              {logFor === p.id ? '收起日志' : '日志'}
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      bordered
      title={
        <Space>
          <ControlOutlined />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>本机进程</span>
        </Space>
      }
      extra={
        <Button size="small" onClick={() => void refresh()}>
          刷新
        </Button>
      }
    >
      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} /> : null}
      {restartingGw ? <Alert type="info" showIcon message="网关重启中，等待恢复…" style={{ marginBottom: 12 }} /> : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={procs ?? []}
        loading={procs === null}
        pagination={false}
        expandable={{
          expandedRowKeys: logFor ? [logFor] : [],
          showExpandColumn: false,
          expandedRowRender: (p) => (
            <div>
              <div className="sub-muted" style={{ marginBottom: 6 }}>
                {p.logFile}
              </div>
              <pre className="pm-log">{logBusy ? '读取中…' : logText || '（暂无日志）'}</pre>
            </div>
          ),
        }}
      />
    </Card>
  );
}

/** 进程管理：操作当前打开的这台网关（web 与 gateway 同端口） */
export function ProcessesPage(props: { token: string }) {
  const pmBase = processApiBase();
  const client = useMemo(() => new PmClient(pmBase, () => props.token), [pmBase, props.token]);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24}>
        <Alert
          type="info"
          showIcon
          message={`进程管理操作当前打开的网关 ${pmBase}（web 与网关同端口）。本机用 127.0.0.1 打开即管本机，用远程部署地址打开即管那台机器；与「远程 · 网关」里切换的控制台连接地址无关。`}
        />
      </Col>
      <Col xs={24}>
        <ProcessTable client={client} />
      </Col>
      <Col xs={24}>
        <ChildGatewayMounts client={client} />
      </Col>
    </Row>
  );
}
