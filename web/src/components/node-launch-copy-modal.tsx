import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Modal, Segmented } from 'antd';
import type { NodeInfo } from '../api';
import { notify } from '../lib/notify';
import {
  formatNodeLaunchSnippet,
  NODE_ENV_FLAVOR_OPTIONS,
  suggestNodeInstanceName,
  type NodeEnvFlavor,
} from '../lib/node-env';

export function NodeLaunchCopyModal(props: {
  open: boolean;
  onClose: () => void;
  node: NodeInfo | null;
  gatewayUrl: string;
  /** 绑定该 nodeId 的 nt_；无则片段不含 TOKEN（需节点机已有 env 或审批模式） */
  nodeToken?: string;
  action?: 'start' | 'restart';
}) {
  const action = props.action ?? 'restart';
  const [flavor, setFlavor] = useState<NodeEnvFlavor>('bash');
  const [instanceName, setInstanceName] = useState('');

  useEffect(() => {
    if (!props.open || !props.node) return;
    setInstanceName(suggestNodeInstanceName(props.node));
    setFlavor('bash');
  }, [props.open, props.node]);

  const snippet = useMemo(() => {
    if (!props.node) return '';
    const agents = props.node.agents.map((a) => a.id).join(',');
    return formatNodeLaunchSnippet(
      {
        gatewayUrl: props.gatewayUrl,
        agents: agents || 'pi',
        token: props.nodeToken,
        nodeName: props.node.name,
        nodeId: props.node.nodeId,
      },
      flavor,
      action,
      instanceName.trim() || undefined,
    );
  }, [props.node, props.gatewayUrl, props.nodeToken, flavor, action, instanceName]);

  const title = action === 'restart' ? '复制重启命令' : '复制启动命令';

  return (
    <Modal
      open={props.open}
      title={props.node ? `${title} · ${props.node.name}` : title}
      onCancel={props.onClose}
      width={640}
      footer={
        <Button onClick={props.onClose}>关闭</Button>
      }
      destroyOnClose
    >
      {props.node ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!props.nodeToken ? (
            <Alert
              type="info"
              showIcon
              message="未绑定 nt_ Key"
              description="片段不含 LINKAGENT_GATEWAY_TOKEN。若工作节点机已有 .runtime-state/node*.env 或走审批模式，可直接重启；否则请在「我的 · 工作节点 Key」查看完整 nt_ 并补进 env。"
            />
          ) : null}
          <div>
            <div className="sub-muted" style={{ marginBottom: 4 }}>
              pnpm 实例名（与 <code>pnpm worker:start &lt;name&gt;</code> 一致）
            </div>
            <Input value={instanceName} onChange={(e) => setInstanceName(e.target.value)} placeholder="builder-01" />
          </div>
          <Segmented value={flavor} options={NODE_ENV_FLAVOR_OPTIONS} onChange={(v) => setFlavor(v as NodeEnvFlavor)} />
          <pre className="enroll-pre" style={{ maxHeight: 280, overflow: 'auto' }}>
            {snippet}
          </pre>
          <Button
            type="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(snippet).then(() => notify.success('已复制到剪贴板'));
            }}
          >
            复制全部（env + {action === 'restart' ? 'restart' : 'start'}）
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
