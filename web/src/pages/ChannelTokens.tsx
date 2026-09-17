import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { OpsClient, type ChannelTokenInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { CopyableCode, EmptyHint } from '../components/common';

export function ChannelTokensPage(props: { base: string; token: string; onAuthError: AuthErrorHandler }) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [rows, setRows] = useState<ChannelTokenInfo[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [userId, setUserId] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await ops.listChannelTokens());
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, tick]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<{ token: string } | void>) => {
    setBusyKey(id);
    try {
      const r = await fn();
      if (r && 'token' in r) {
        setRevealed({ id, token: r.token });
        notify.success('凭据已生成，请立即复制保存');
      }
      await load();
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const columns: ColumnsType<ChannelTokenInfo> = [
    {
      title: '凭据',
      dataIndex: 'tokenPreview',
      key: 'tokenPreview',
      render: (v: string) => <code className="code-cell">{v}</code>,
    },
    {
      title: '所属用户',
      key: 'user',
      render: (_, r) => (
        <code className="code-cell">
          {r.channel}:{r.userId}
        </code>
      ),
    },
    {
      title: '签发时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      responsive: ['md'],
      render: (v: string) => <span className="sub-muted">{dayjs(v).format('YYYY-MM-DD HH:mm')}</span>,
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      responsive: ['md'],
      render: (v?: string) => (v ? <span className="sub-muted">{dayjs(v).format('YYYY-MM-DD HH:mm')}</span> : '—'),
    },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, r) => {
        const id = `${r.channel}:${r.userId}`;
        return (
          <Space size={6}>
            <Button
              size="small"
              loading={busyKey === `rotate:${id}`}
              onClick={() => void run(`rotate:${id}`, () => ops.rotateChannelToken(r.channel, r.userId))}
            >
              轮换
            </Button>
            <Popconfirm
              title={`确认吊销 ${id} 的用户凭据？`}
              description="bot 下次消息将自动重新签发。"
              okText="吊销"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void run(`revoke:${id}`, () => ops.revokeChannelTokenByUser(r.channel, r.userId))}
            >
              <Button size="small" danger loading={busyKey === `revoke:${id}`}>
                吊销
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <p className="page-desc">
        每个微信用户一枚用户级 token（<code>ct_</code> 前缀），微信 bot 代该用户直连网关，只能访问其本人的任务，不能触碰管理接口。
        Chatbox 任务级直连请用「Key 管理」里的任务 key。
      </p>

      <Space.Compact style={{ marginBottom: 14, width: '100%', maxWidth: 560 }}>
        <Input value="weixin" disabled style={{ width: 110 }} />
        <Input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="微信用户 id（from_user_id）"
          onPressEnter={() =>
            userId.trim() &&
            void run('ensure', () => ops.ensureChannelToken('weixin', userId.trim())).then(() => setUserId(''))
          }
        />
        <Button
          type="primary"
          disabled={!userId.trim() || busyKey === 'ensure'}
          loading={busyKey === 'ensure'}
          onClick={() =>
            void run('ensure', () => ops.ensureChannelToken('weixin', userId.trim())).then(() => setUserId(''))
          }
        >
          获取 / 签发
        </Button>
      </Space.Compact>

      {revealed ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="完整 token（仅显示一次，请妥善复制）"
          description={
            <Space size={8} wrap style={{ marginTop: 6 }}>
              <CopyableCode text={revealed.token} block />
              <Button size="small" onClick={() => setRevealed(null)}>
                关闭
              </Button>
            </Space>
          }
        />
      ) : null}

      <Table
        rowKey={(r) => `${r.channel}:${r.userId}`}
        columns={columns}
        dataSource={rows ?? []}
        loading={rows === null}
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: <EmptyHint text="暂无用户凭据（微信用户首次发消息时自动签发）" /> }}
      />
    </div>
  );
}
