import { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  newProfileId,
  readProfiles,
  writeProfiles,
  type GatewayProfile,
} from '../lib/constants';
import { confirmAsync, notify } from '../lib/notify';

export interface ProfileFormValues {
  name: string;
  url: string;
  token?: string;
}

export function useGatewayProfiles() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>(() => readProfiles());

  const persistProfiles = (next: GatewayProfile[]) => {
    setProfiles(next);
    writeProfiles(next);
  };

  const upsert = (editing: GatewayProfile | null, values: ProfileFormValues) => {
    if (editing) {
      persistProfiles(profiles.map((p) => (p.id === editing.id ? { ...p, ...values } : p)));
      notify.success('远程网关已更新');
    } else {
      persistProfiles([...profiles, { id: newProfileId(), ...values }]);
      notify.success('远程网关已添加');
    }
  };

  const remove = async (p: GatewayProfile) => {
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

  return { profiles, persistProfiles, upsert, remove };
}

export function ProfileEditModal(props: {
  open: boolean;
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
      props.onSubmit({
        name: values.name.trim(),
        url: values.url.trim().replace(/\/+$/, ''),
        token: values.token?.trim() ?? '',
      });
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

export function GatewayProfilesList(props: {
  profiles: GatewayProfile[];
  onEdit: (p: GatewayProfile) => void;
  onRemove: (p: GatewayProfile) => void;
  onAdd: () => void;
  onConnect?: (p: GatewayProfile) => void;
}) {
  const columns: ColumnsType<GatewayProfile> = [
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
      width: props.onConnect ? 220 : 140,
      render: (_, p) => (
        <Space size={6}>
          {props.onConnect ? (
            <Button size="small" type="primary" ghost onClick={() => props.onConnect?.(p)}>
              连接
            </Button>
          ) : null}
          <Button size="small" icon={<EditOutlined />} onClick={() => props.onEdit(p)}>
            编辑
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void props.onRemove(p)} />
        </Space>
      ),
    },
  ];

  return (
    <>
      <Table rowKey="id" size="small" columns={columns} dataSource={props.profiles} pagination={false} />
      <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={props.onAdd}>
        添加远程网关
      </Button>
    </>
  );
}
