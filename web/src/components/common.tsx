import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Card, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, ClockCircleOutlined, CopyOutlined, MinusCircleFilled } from '@ant-design/icons';

const { Text } = Typography;

/** 页面区块卡片：统一标题、副标题与右侧操作区 */
export function PageCard(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <Card
      styles={{ body: props.bodyStyle }}
      style={props.style}
      title={
        props.title ? (
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: '#eef2f8' }}>{props.title}</div>
            {props.subtitle ? <div className="sub-muted" style={{ marginTop: 2, fontWeight: 400 }}>{props.subtitle}</div> : null}
          </div>
        ) : undefined
      }
      extra={props.extra}
      bordered
    >
      {props.error ? <Alert type="error" showIcon message={props.error} style={{ marginBottom: 12 }} /> : null}
      {props.loading ? <Skeleton active paragraph={{ rows: 4 }} /> : props.children}
    </Card>
  );
}

/** 统一空状态 */
export function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ padding: '30px 0', textAlign: 'center' }}>
      <Text type="secondary" style={{ fontSize: 13 }}>
        {text}
      </Text>
    </div>
  );
}

/** 概览指标卡 */
export function StatCard(props: {
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
  loading?: boolean;
}) {
  return (
    <Card className="stat-card" bordered styles={{ body: { padding: 0 } }}>
      <div className="ant-card-body" style={{ padding: '16px 18px' }}>
        <div className="stat-head">
          <div>
            <div className="stat-value">
              {props.loading ? '—' : props.value}
              {props.unit ? <span className="unit">{props.unit}</span> : null}
            </div>
            <div className="stat-label">{props.label}</div>
          </div>
          <div className="stat-icon" style={{ background: props.iconBg, color: props.iconColor }}>
            {props.icon}
          </div>
        </div>
        {props.foot ? <div className="stat-foot">{props.foot}</div> : null}
      </div>
    </Card>
  );
}

/** 在线/离线/待审批/已拒绝/已禁用 状态徽章 */
export function StateTag(props: {
  state: 'on' | 'off' | 'pending' | 'blocked' | 'disabled';
  labels?: Record<string, string>;
}) {
  const map = {
    on: { color: 'success', icon: <CheckCircleFilled />, text: '在线' },
    off: { color: 'default', icon: <MinusCircleFilled />, text: '离线' },
    pending: { color: 'warning', icon: <ClockCircleOutlined />, text: '待审批' },
    blocked: { color: 'error', icon: <MinusCircleFilled />, text: '已拒绝' },
    disabled: { color: 'default', icon: <MinusCircleFilled />, text: '已禁用' },
  } as const;
  const c = map[props.state];
  const text = props.labels?.[props.state] ?? c.text;
  return (
    <Tag icon={c.icon} color={c.color} style={{ borderRadius: 999, marginInlineEnd: 0 }}>
      {text}
    </Tag>
  );
}

/** 启用/停用 状态点 */
export function EnabledTag({ enabled, on = '启用', off = '停用' }: { enabled: boolean; on?: string; off?: string }) {
  return (
    <Tag color={enabled ? 'success' : 'default'} style={{ borderRadius: 999, marginInlineEnd: 0 }}>
      {enabled ? on : off}
    </Tag>
  );
}

/** 可复制的等宽文本（Key / token / 命令） */
export function CopyableCode(props: {
  text: string;
  title?: string;
  truncate?: boolean;
  block?: boolean;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <Tooltip title={copied ? '已复制' : props.title ?? '点击复制'}>
      <span
        className="copyable-code"
        onClick={copy}
        style={{
          cursor: 'pointer',
          color: '#aebdd4',
          display: props.block ? 'flex' : 'inline-flex',
          fontSize: props.size ?? 12,
        }}
      >
        <code className="code-text" style={props.truncate ? { maxWidth: 220 } : undefined}>
          {props.text}
        </code>
        <CopyOutlined style={{ fontSize: 11, color: 'rgba(229,233,240,0.35)', flex: '0 0 auto' }} />
      </span>
    </Tooltip>
  );
}

/** 表格加载/错误/空数据统一渲染辅助 */
export function tableState(loading: boolean, error: string | null, emptyText: string, empty: boolean) {
  if (error) return { locale: { emptyText: <Alert type="error" showIcon message={error} style={{ margin: 12 }} /> } };
  if (loading) return { loading: true };
  if (empty) return { locale: { emptyText } };
  return {};
}
