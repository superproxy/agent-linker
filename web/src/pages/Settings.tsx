import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Form, Input, Modal, Radio, Row, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApiOutlined,
  CloudServerOutlined,
  ControlOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  PmClient,
  type ChildGatewayId,
  type ChildGatewayTargetInfo,
  type PmProcess,
  type SystemInfo,
} from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { newProfileId, readProfiles, writeProfiles, type GatewayProfile } from '../lib/constants';

interface ProfileFormValues {
  name: string;
  url: string;
  token?: string;
}

function ProfileEditModal(props: {
  open: boolean;
  /** 传入已有 profile 为编辑，null 为新增 */
  profile: GatewayProfile | null;
  onCancel: () => void;
  onSubmit: (values: ProfileFormValues) => void;
}) {
  const [form] = Form.useForm<ProfileFormValues>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    form.setFieldsValue(
      props.profile
        ? { name: props.profile.name, url: props.profile.url, token: props.profile.token ?? '' }
        : { name: '', url: '', token: '' },
    );
  }, [props.open, props.profile, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      props.onSubmit({ name: values.name.trim(), url: values.url.trim().replace(/\/+$/, ''), token: values.token?.trim() ?? '' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title={props.profile ? '编辑远程网关' : '添加远程网关'}
      okText={props.profile ? '保存' : '添加'}
      cancelText="取消"
      confirmLoading={busy}
      onCancel={props.onCancel}
      onOk={() => void submit()}
      destroyOnClose
      maskClosable={false}
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 12 }}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, whitespace: true, message: '请输入网关名称' }]}
        >
          <Input placeholder="例如：公司测试环境" spellCheck={false} maxLength={40} />
        </Form.Item>
        <Form.Item
          name="url"
          label="网关地址"
          rules={[
            { required: true, whitespace: true, message: '请输入网关地址' },
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
        <Form.Item
          name="token"
          label="访问 Token（可选）"
          tooltip="远程网关开启鉴权时填写其 gateway token，作为微信/node 进程回连凭据"
        >
          <Input.Password placeholder="远程网关免鉴权可留空" spellCheck={false} autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface MountFormValues {
  scope: 'local' | 'remote';
  url: string;
  token: string;
}

/** 设置某子进程的挂载网关弹窗：本机 / 远程（可从已保存清单带入） */
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

/** 本机微信/node 进程的挂载网关配置（仅本机回环可访问） */
function ChildGatewayMounts(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const client = useMemo(() => new PmClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [targets, setTargets] = useState<Record<ChildGatewayId, ChildGatewayTargetInfo> | null>(null);
  const [profiles, setProfiles] = useState<GatewayProfile[]>(() => readProfiles());
  const [err, setErr] = useState<string | null>(null);
  const [mountFor, setMountFor] = useState<ChildGatewayId | null>(null);
  const [profileModal, setProfileModal] = useState<{ open: boolean; editing: GatewayProfile | null }>({
    open: false,
    editing: null,
  });

  const refresh = useCallback(async () => {
    try {
      setTargets(await client.gatewayTargets());
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persistProfiles = (next: GatewayProfile[]) => {
    setProfiles(next);
    writeProfiles(next);
  };

  const handleProfileSubmit = (values: ProfileFormValues) => {
    if (profileModal.editing) {
      persistProfiles(
        profiles.map((p) => (p.id === profileModal.editing?.id ? { ...p, ...values } : p)),
      );
      notify.success('远程网关已更新');
    } else {
      persistProfiles([...profiles, { id: newProfileId(), ...values }]);
      notify.success('远程网关已添加');
    }
    setProfileModal({ open: false, editing: null });
  };

  const removeProfile = async (p: GatewayProfile) => {
    const ok = await confirmAsync({
      title: `删除网关「${p.name}」？`,
      content: '仅删除本浏览器保存的地址配置，不影响已挂载该网关的进程。',
      okText: '删除',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    persistProfiles(profiles.filter((x) => x.id !== p.id));
    notify.success('已删除');
  };

  const submitMount = async (id: ChildGatewayId, values: { url: string; token: string }) => {
    const r = await client.setGatewayTarget(id, values.url, values.token);
    setTargets(r.targets);
    setMountFor(null);
    notify.success(`已保存，${id === 'weixin' ? '微信 bot' : 'node'} 已重启`);
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

  const profileColumns: ColumnsType<GatewayProfile> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>,
    },
    {
      title: '地址',
      dataIndex: 'url',
      key: 'url',
      render: (url: string) => <code className="code-cell">{url}</code>,
    },
    {
      title: 'Token',
      key: 'token',
      width: 110,
      render: (_, p) =>
        p.token ? <Tag style={{ borderRadius: 999 }}>已设置</Tag> : <span className="sub-muted">未设置</span>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      render: (_, p) => (
        <Space size={6}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => setProfileModal({ open: true, editing: p })}
          >
            编辑
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void removeProfile(p)} />
        </Space>
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
        message="本机的微信 bot 与 node 进程可分别挂载到本机或远程网关；保存后自动重启对应进程。"
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
      <Table rowKey="id" size="small" columns={profileColumns} dataSource={profiles} pagination={false} />
      <Button
        type="dashed"
        block
        icon={<PlusOutlined />}
        style={{ marginTop: 12 }}
        onClick={() => setProfileModal({ open: true, editing: null })}
      >
        添加远程网关
      </Button>
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
        onSubmit={handleProfileSubmit}
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

function ProcessManager(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const client = useMemo(() => new PmClient(props.base, () => props.token), [props.base, props.token]);
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
      setProcs(await client.status());
      setErr(null);
    } catch (e) {
      if (!props.onAuthError(e)) setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

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
      if (op === 'start') setProcs(await client.start([id]));
      else if (op === 'stop') setProcs(await client.stop([id]));
      else {
        const r = await client.restart([id]);
        if (r.gateway) {
          setRestartingGw(true);
          notify.info('网关重启中，等待恢复…');
          await waitGatewayBack(client);
          setRestartingGw(false);
          notify.success('网关已恢复');
        }
        if (r.processes) setProcs(r.processes);
      }
      await refresh();
    } catch (e) {
      if (!props.onAuthError(e)) {
        setErr(e instanceof Error ? e.message : String(e));
        setRestartingGw(false);
      }
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
      setLogText(await client.logs(id, 200));
    } catch (e) {
      if (!props.onAuthError(e)) setLogText(`读取日志失败：${e instanceof Error ? e.message : String(e)}`);
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
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>进程管理</span>
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
      <Table rowKey="id" columns={columns} dataSource={procs ?? []} loading={procs === null} pagination={false} expandable={{
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
      }} />
    </Card>
  );
}

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
            管理后台连接的网关地址（输入完整后点击「切换并重连」才会切换）
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
      {info?.local ? (
        <>
          <Col xs={24}>
            <ChildGatewayMounts base={props.base} token={props.token} onAuthError={props.onAuthError} />
          </Col>
          <Col xs={24}>
            <ProcessManager base={props.base} token={props.token} onAuthError={props.onAuthError} />
          </Col>
        </>
      ) : null}
    </Row>
  );
}
