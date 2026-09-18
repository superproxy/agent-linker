import { useCallback, useEffect, useMemo, useState } from 'react';
import { Col, Row, Tag } from 'antd';
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  KeyOutlined,
  MessageOutlined,
  WechatOutlined,
} from '@ant-design/icons';
import {
  AdminClient,
  GatewayClient,
  OpsClient,
  WeixinClient,
  type AgentDetail,
  type ModelInfo,
  type NodeInfo,
  type UserTasks,
  type WeixinStatus,
} from '../api';
import { useRefreshTick } from '../lib/hooks';
import { StatCard } from '../components/common';
import type { PageProps } from './types';

export function Overview(props: PageProps) {
  const { base, token, onAuthError } = props;
  const client = useMemo(() => new GatewayClient(base, () => token), [base, token]);
  const admin = useMemo(() => new AdminClient(base, token), [base, token]);
  const ops = useMemo(() => new OpsClient(base, () => token), [base, token]);
  const wx = useMemo(() => new WeixinClient(base, () => token), [base, token]);
  const { tick } = useRefreshTick();

  const [agents, setAgents] = useState<AgentDetail[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [users, setUsers] = useState<UserTasks[] | null>(null);
  const [wxStatus, setWxStatus] = useState<WeixinStatus | null>(null);

  const [models, setModels] = useState<ModelInfo[]>([]);

  const loadStats = useCallback(async () => {
    const [aRes, nRes, tRes, wRes] = await Promise.allSettled([
      admin.listAgents().then(async (list) => ({ list, def: await admin.getDefaultAgent() })),
      ops.listNodes(),
      ops.listAllTasks(),
      wx.status(),
    ]);
    if (aRes.status === 'fulfilled') {
      setAgents(aRes.value.list);
      setDefaultAgentId(aRes.value.def);
    } else if (onAuthError(aRes.reason)) return;
    if (nRes.status === 'fulfilled') setNodes(nRes.value);
    else onAuthError(nRes.reason);
    if (tRes.status === 'fulfilled') setUsers(tRes.value);
    else onAuthError(tRes.reason);
    if (wRes.status === 'fulfilled') setWxStatus(wRes.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, ops, wx, tick]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    let alive = true;
    client
      .models()
      .then((m) => alive && setModels(m))
      .catch((e) => !onAuthError(e) && undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick]);

  const enabledAgents = (agents ?? []).filter((a) => a.enabled).length;
  const onlineNodes = (nodes ?? []).filter((n) => n.status !== 'pending' && n.status !== 'blocked' && n.online).length;
  const pendingNodes = (nodes ?? []).filter((n) => n.status === 'pending').length;
  const taskCount = (users ?? []).reduce((s, u) => s + u.tasks.length, 0);
  const keyCount = (users ?? []).reduce((s, u) => s + u.tasks.filter((t) => t.key).length, 0);

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<AppstoreOutlined />}
            iconBg="rgba(59,130,246,0.14)"
            iconColor="#60a5fa"
            label="启用 Agent"
            value={agents ? enabledAgents : '—'}
            unit={agents ? `/ ${agents.length}` : ''}
            foot={defaultAgentId ? <>默认 <code className="mono">{defaultAgentId}</code></> : '加载中'}
            loading={!agents}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<ClusterOutlined />}
            iconBg="rgba(34,197,94,0.14)"
            iconColor="#4ade80"
            label="在线节点"
            value={nodes ? onlineNodes : '—'}
            unit="个"
            foot={pendingNodes > 0 ? <Tag color="warning" style={{ borderRadius: 999 }}>{pendingNodes} 待审批</Tag> : '本机始终可用'}
            loading={!nodes}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<MessageOutlined />}
            iconBg="rgba(168,85,247,0.14)"
            iconColor="#c084fc"
            label="任务总数"
            value={users ? taskCount : '—'}
            unit="个"
            foot={`${users ? users.length : 0} 个渠道终端`}
            loading={!users}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<KeyOutlined />}
            iconBg="rgba(234,179,8,0.14)"
            iconColor="#facc15"
            label="活跃 Key"
            value={users ? keyCount : '—'}
            unit="枚"
            foot="任务级直连凭据"
            loading={!users}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<WechatOutlined />}
            iconBg={wxStatus?.configured ? 'rgba(34,197,94,0.14)' : 'rgba(148,163,184,0.14)'}
            iconColor={wxStatus?.configured ? '#4ade80' : '#94a3b8'}
            label="微信渠道"
            value={wxStatus ? (wxStatus.configured ? '已绑定' : '未绑定') : '—'}
            foot={wxStatus?.activeAccountId ? `账号 ${wxStatus.activeAccountId}` : '可在微信登录页绑定'}
            loading={!wxStatus}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            icon={<CheckCircleOutlined />}
            iconBg="rgba(59,130,246,0.14)"
            iconColor="#60a5fa"
            label="可用模型"
            value={models.length || '—'}
            unit={models.length ? '个' : ''}
            foot="OpenAI 兼容接口"
            loading={models.length === 0}
          />
        </Col>
      </Row>
      <p className="page-desc" style={{ marginTop: 18 }}>
        流式对话已独立到侧栏「对话」。任务级持久会话请从「任务管理」点「对话」进入。
      </p>
    </div>
  );
}
