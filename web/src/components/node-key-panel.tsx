import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Segmented, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError, OpsClient, type NodeTokenInfo } from '../api';
import { useRefreshTick, type AuthErrorHandler } from '../lib/hooks';
import { notify } from '../lib/notify';
import { CopyableCode } from './common';
import {
  formatNodeEnv,
  NODE_ENV_FLAVOR_OPTIONS,
  type NodeEnvFlavor,
} from '../lib/node-env';

function guessGatewayUrl(port: number): string {
  if (typeof window === 'undefined') return `ws://GATEWAY_HOST:${port}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname || 'GATEWAY_HOST';
  return `${proto}://${host}:${port}`;
}

function copyEnvLabel(flavor: NodeEnvFlavor, copied: boolean): string {
  if (copied) return '已复制';
  if (flavor === 'bash') return '复制 Bash';
  if (flavor === 'powershell') return '复制 PowerShell';
  return '复制 env 文件';
}

/** 登录用户名下的节点机器凭证 nt_ */
export function NodeKeyPanel(props: {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  /** 嵌入接入向导时使用紧凑样式 */
  embedded?: boolean;
  /** 接入向导传入：与下方 env 格式联动 */
  envContext?: { gatewayUrl: string; agents: string };
  envFlavor?: NodeEnvFlavor;
}) {
  const ops = useMemo(() => new OpsClient(props.base, () => props.token), [props.base, props.token]);
  const { tick } = useRefreshTick();
  const [mine, setMine] = useState<NodeTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewNt, setViewNt] = useState<{ preview: string; full?: string; label?: string } | null>(null);
  const [envDefaults, setEnvDefaults] = useState<{ gatewayUrl: string; agents: string } | null>(null);
  const [localEnvFlavor, setLocalEnvFlavor] = useState<NodeEnvFlavor>('dotenv');
  const [envCopied, setEnvCopied] = useState(false);

  const envFlavor = props.envFlavor ?? localEnvFlavor;
  const envContext = props.envContext ?? envDefaults;

  useEffect(() => {
    if (props.envContext) return;
    let alive = true;
    void (async () => {
      try {
        const i = await ops.nodeEnroll();
        if (!alive) return;
        setEnvDefaults({
          gatewayUrl: guessGatewayUrl(i.port),
          agents: i.defaultAgents.map((a) => a.id).join(','),
        });
      } catch {
        /* 独立页缺省 env 时仍展示裸 token */
      }
    })();
    return () => {
      alive = false;
    };
  }, [ops, props.envContext]);

  const refreshTokens = useCallback(async () => {
    setLoading(true);
    try {
      setMine(await ops.listNodeTokens());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMine([]);
        return;
      }
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ops, props]);

  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens, tick]);

  const issue = async () => {
    setBusy('issue');
    try {
      const r = await ops.issueNodeToken(label || undefined);
      setRevealed({ id: r.id, token: r.token });
      setLabel('');
      await refreshTokens();
      notify.success('已颁发节点 Key，请复制到节点 env');
    } catch (e) {
      if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tokenCols: ColumnsType<NodeTokenInfo> = [
    {
      title: '节点 Key（nt_）',
      key: 'p',
      render: (_, t) => (
        <div>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto' }}
            onClick={() => {
              const full = revealed?.id === t.id ? revealed.token : undefined;
              setViewNt({ preview: t.tokenPreview, full, label: t.label });
            }}
          >
            <code className="code-cell">{t.tokenPreview}</code>
          </Button>
          {t.label ? <div className="sub-muted">{t.label}</div> : null}
        </div>
      ),
    },
    {
      title: '绑定节点',
      key: 'n',
      render: (_, t) => (t.nodeId ? <code className="code-cell">{t.nodeId}</code> : <span className="sub-muted">未连接</span>),
    },
    {
      title: '操作',
      key: 'ops',
      width: 160,
      render: (_, t) => (
        <Space size={6}>
          <Button
            size="small"
            disabled={busy === t.id}
            onClick={() =>
              void (async () => {
                setBusy(t.id);
                try {
                  const r = await ops.rotateNodeToken(t.id);
                  setRevealed({ id: r.id, token: r.token });
                  await refreshTokens();
                  notify.success('已轮换，请更新节点 env');
                } catch (e) {
                  if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              })()
            }
          >
            轮换
          </Button>
          <Popconfirm
            title="吊销这枚节点 Key？"
            okText="吊销"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              void (async () => {
                setBusy(t.id);
                try {
                  await ops.revokeNodeToken(t.id);
                  if (revealed?.id === t.id) setRevealed(null);
                  await refreshTokens();
                  notify.success('已吊销');
                } catch (e) {
                  if (!props.onAuthError(e)) notify.error(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              })()
            }
          >
            <Button size="small" danger disabled={busy === t.id}>
              吊销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {!props.embedded ? (
        <p className="page-desc" style={{ marginBottom: 10 }}>
          每台远程节点一枚 <strong>nt_</strong>，填入 <code>LINKAGENT_GATEWAY_TOKEN</code>。接入步骤与环境变量见「远程 · 节点」。
        </p>
      ) : null}

      <Space.Compact style={{ width: '100%', maxWidth: 480, marginBottom: revealed ? 10 : 14 }}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注，例如家里的 PC" />
        <Button type="primary" loading={busy === 'issue'} onClick={() => void issue()}>
          颁发
        </Button>
      </Space.Compact>

      {revealed ? (
        <div className="enroll-block" style={{ marginBottom: 14 }}>
          <div className="sub-muted" style={{ marginBottom: 6 }}>
            完整 nt_（仅显示一次）
          </div>
          <CopyableCode text={revealed.token} block size={13} />
          {envContext ? (
            <>
              {!props.embedded ? (
                <div style={{ marginTop: 12 }}>
                  <div className="sub-muted" style={{ marginBottom: 6 }}>
                    环境变量片段
                  </div>
                  <Segmented
                    value={envFlavor}
                    options={NODE_ENV_FLAVOR_OPTIONS}
                    onChange={(v) => setLocalEnvFlavor(v as NodeEnvFlavor)}
                  />
                </div>
              ) : null}
              <pre className="enroll-pre" style={{ marginTop: 10 }}>
                {formatNodeEnv({ ...envContext, token: revealed.token }, envFlavor)}
              </pre>
              <Space size={8} wrap style={{ marginTop: 8 }}>
                <Button
                  size="small"
                  onClick={() => {
                    const text = formatNodeEnv({ ...envContext, token: revealed.token }, envFlavor);
                    void navigator.clipboard?.writeText(text).then(() => {
                      setEnvCopied(true);
                      setTimeout(() => setEnvCopied(false), 1500);
                      notify.success('已复制环境变量');
                    });
                  }}
                >
                  {copyEnvLabel(envFlavor, envCopied)}
                </Button>
                <Button size="small" onClick={() => setRevealed(null)}>
                  关闭
                </Button>
              </Space>
            </>
          ) : (
            <Button size="small" style={{ marginTop: 8 }} onClick={() => setRevealed(null)}>
              关闭
            </Button>
          )}
        </div>
      ) : null}

      <Table rowKey="id" size="small" pagination={false} columns={tokenCols} dataSource={mine} loading={loading} />

      <Modal
        open={viewNt !== null}
        title="节点 Key（nt_）"
        onCancel={() => setViewNt(null)}
        footer={<Button onClick={() => setViewNt(null)}>关闭</Button>}
        destroyOnClose
      >
        {viewNt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {viewNt.label ? <div className="sub-muted">备注：{viewNt.label}</div> : null}
            {viewNt.full ? (
              <>
                <div className="sub-muted">完整凭证</div>
                <CopyableCode text={viewNt.full} block size={13} />
              </>
            ) : (
              <>
                <div>
                  预览：<code className="code-cell">{viewNt.preview}</code>
                </div>
                <div className="sub-muted">完整 nt_ 不在列表中保存；遗失请「轮换」或重新「颁发」。</div>
              </>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
