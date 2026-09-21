import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Space, Table, Tag } from 'antd';
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

  const issueOrRotate = (uid: string) => {
    const exists = (rows ?? []).some((r) => r.channel === 'weixin' && r.userId === uid);
    return exists ? ops.rotateChannelToken('weixin', uid) : ops.ensureChannelToken('weixin', uid);
  };

  const columns: ColumnsType<ChannelTokenInfo> = [
    {
      title: '凭据',
      dataIndex: 'tokenPreview',
      key: 'tokenPreview',
      render: (v: string) => <code className="code-cell">{v}</code>,
    },
    {
      title: '渠道 / 终端',
      key: 'user',
      render: (_, r) => (
        <Space size={6}>
          <Tag color={r.channel === 'weixin' ? 'green' : 'default'} style={{ borderRadius: 999, marginInlineEnd: 0 }}>
            {r.channel === 'weixin' ? '微信' : r.channel}
          </Tag>
          <code className="code-cell">{r.userId}</code>
          {r.ownerUsername ? <span className="sub-muted">{r.ownerUsername}</span> : null}
        </Space>
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
              title={`确认吊销 ${id} 的渠道凭据？`}
              description="该终端下次发消息时 bot 将自动重新签发。"
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
        每个渠道终端（微信 openid）一枚终端级 token（<code>ct_</code> 前缀），微信 bot 代该终端直连网关，只能访问其本人的会话任务，不能触碰管理接口。
        重新绑定或取消绑定微信会吊销该账号槽的 <code>ct_</code> 并重启 bot（清本地缓存），下次消息自动签发新 token。后台「Key」页的 <code>k_</code> 是任务直连 key，换绑微信不会更换。「获取 / 签发」对已有终端会重新生成。
      </p>

      <Space.Compact style={{ marginBottom: 14, width: '100%', maxWidth: 560 }}>
        <Input value="weixin" disabled style={{ width: 110 }} />
        <Input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="微信终端 id（from_user_id / openid）"
          onPressEnter={() =>
            userId.trim() &&
            void run('ensure', () => issueOrRotate(userId.trim())).then(() => setUserId(''))
          }
        />
        <Button
          type="primary"
          disabled={!userId.trim() || busyKey === 'ensure'}
          loading={busyKey === 'ensure'}
          onClick={() =>
            void run('ensure', () => issueOrRotate(userId.trim())).then(() => setUserId(''))
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
        locale={{ emptyText: <EmptyHint text="暂无渠道凭据（微信终端首次发消息时自动签发）" /> }}
      />
    </div>
  );
}
