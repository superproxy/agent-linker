import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Space, Table, Tabs, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { AuthClient, type PersonalTokenInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { CopyableCode, EmptyHint } from '../components/common';
import { ChannelTerminalKeyPanel } from '../components/channel-terminal-key-panel';

function PersonalKeySection(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
}) {
  const client = useMemo(() => new AuthClient(props.base), [props.base]);
  const { tick } = useRefreshTick();
  const [info, setInfo] = useState<PersonalTokenInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await client.personalToken(props.token));
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, props.token, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    try {
      setRevealed(await fn());
      await load();
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    const ok = await confirmAsync({
      title: '确认吊销你的 API token？',
      content: '吊销后所有客户端将无法使用，可随时重新获取。',
      okText: '吊销',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    setBusy('revoke');
    try {
      await client.revokePersonalToken(props.token);
      setRevealed(null);
      await load();
      notify.success('已吊销');
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const endpoint = props.base.replace(/\/$/, '') + '/v1/chat/completions';
  const columns: ColumnsType<PersonalTokenInfo> = [
    {
      title: '用户 Key（pat_）',
      dataIndex: 'tokenPreview',
      key: 'tokenPreview',
      render: (v: string) => <code className="code-cell">{v}</code>,
    },
    {
      title: '签发时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => <span className="sub-muted">{dayjs(v).format('YYYY-MM-DD HH:mm')}</span>,
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (v?: string) => (v ? <span className="sub-muted">{dayjs(v).format('YYYY-MM-DD HH:mm')}</span> : '—'),
    },
  ];

  return (
    <div>
      <p className="page-desc" style={{ marginBottom: 10 }}>
        以<strong>登录账号</strong>身份调用 /v1 的 <strong>pat_</strong>；完整明文仅在签发/轮换后出现一次。
      </p>
      <Space style={{ marginBottom: 14 }} wrap>
        <Button type="primary" loading={busy === 'ensure'} onClick={() => void run('ensure', () => client.ensurePersonalToken(props.token))}>
          {info ? '查看 / 重新获取' : '获取 / 签发'}
        </Button>
        <Button
          disabled={!info || busy === 'rotate'}
          onClick={async () => {
            const ok = await confirmAsync({
              title: '轮换 API token？',
              content: '旧 token 立即失效，需要更新所有客户端。',
              okText: '轮换',
            });
            if (ok) await run('rotate', () => client.rotatePersonalToken(props.token));
          }}
        >
          轮换
        </Button>
        <Button danger disabled={!info || busy === 'revoke'} onClick={() => void revoke()}>
          吊销
        </Button>
      </Space>
      {revealed ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 14 }}
          message="完整 token（仅显示一次）"
          description={
            <Space direction="vertical" style={{ marginTop: 6 }} size={8}>
              <CopyableCode text={revealed} block size={13} />
              <Button size="small" onClick={() => setRevealed(null)}>
                关闭
              </Button>
            </Space>
          }
        />
      ) : null}
      <Table
        rowKey="tokenPreview"
        columns={columns}
        dataSource={info ? [info] : []}
        loading={info === undefined}
        pagination={false}
        locale={{ emptyText: <EmptyHint text="还没有 pat_，点击「获取 / 签发」生成。" /> }}
      />
      <Descriptions
        size="small"
        column={1}
        bordered
        style={{ marginTop: 16 }}
        labelStyle={{ width: 140, color: 'rgba(229,233,240,0.5)' }}
        items={[
          {
            key: 'ep',
            label: '接口地址 Base URL',
            children: (
              <Space>
                <Tag color="blue" style={{ borderRadius: 6 }}>
                  POST
                </Tag>
                <code className="code-cell">{endpoint}</code>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}

export function MyTokenPage(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  isAdmin: boolean;
}) {
  const tabItems = [
    {
      key: 'pat',
      label: '登录 API（pat_）',
      children: <PersonalKeySection base={props.base} token={props.token} onAuthError={props.onAuthError} />,
    },
    ...(props.isAdmin
      ? [
          {
            key: 'ct',
            label: '微信终端（ct_）',
            children: (
              <ChannelTerminalKeyPanel base={props.base} token={props.token} onAuthError={props.onAuthError} />
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <p className="page-desc" style={{ marginBottom: 12 }}>
        <strong>用户 Key</strong>：登录账号的 API 凭据；管理员另可管理微信对话对象的 <strong>ct_</strong>。
      </p>
      <Tabs items={tabItems} />
    </div>
  );
}
