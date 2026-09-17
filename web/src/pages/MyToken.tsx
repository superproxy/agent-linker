import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { AuthClient, type PersonalTokenInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { CopyableCode, EmptyHint } from '../components/common';

export function MyTokenPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
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
      title: '凭据',
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
      <p className="page-desc">
        属于你账号的长期 token（<code>pat_</code> 前缀），可填入 Chatbox 等 OpenAI 兼容客户端的 <code>API Key</code>，
        以你本人身份调用网关，权限与账号一致。任务级直连请用「Key 管理」里的任务 key。
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
          message="完整 token（仅显示一次，请妥善复制）"
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
        locale={{ emptyText: <EmptyHint text="你还没有个人 API token，点击「获取 / 签发」生成一枚。" /> }}
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
