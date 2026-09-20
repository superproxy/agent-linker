import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDefSchema, migrateConfig } from '@linkagent/shared/config';

const FULL_POLICY = {
  autoApprove: ['bash:read', 'edit:read'],
  autoDeny: ['bash:write'],
  escalate: ['bash'],
  defaultAction: 'deny',
} as const;

test('agentDefSchema：permissionPolicy 完整结构解析为定义字段', () => {
  const def = agentDefSchema.parse({
    id: 'opencode',
    type: 'opencode',
    permissionPolicy: FULL_POLICY,
  });
  assert.deepEqual(def.permissionPolicy, FULL_POLICY);
});

test('agentDefSchema：permissionPolicy 缺省 / 空对象均合法', () => {
  const a = agentDefSchema.parse({ id: 'x', type: 'opencode', permissionPolicy: {} });
  assert.deepEqual(a.permissionPolicy, {});
  const b = agentDefSchema.parse({ id: 'y', type: 'opencode' });
  assert.equal(b.permissionPolicy, undefined);
});

test('agentDefSchema：非法 defaultAction / 非数组字段被拒绝', () => {
  assert.throws(() =>
    agentDefSchema.parse({
      id: 'x',
      type: 'opencode',
      permissionPolicy: { defaultAction: 'allow' },
    }),
  );
  assert.throws(() =>
    agentDefSchema.parse({
      id: 'x',
      type: 'opencode',
      permissionPolicy: { autoApprove: 'bash:read' },
    }),
  );
});

test('migrateConfig：旧扁平 agents 段的 permissionPolicy 迁移保留到 gateway.agents', () => {
  const cfg = migrateConfig({
    server: { host: '127.0.0.1', port: 8787 },
    auth: { mode: 'local', token: '' },
    agents: [
      {
        id: 'pi',
        type: 'pi',
        permissionPolicy: { autoDeny: ['bash:write'], defaultAction: 'approve' },
      },
    ],
  });
  assert.deepEqual(cfg.gateway.agents[0]?.permissionPolicy, {
    autoDeny: ['bash:write'],
    defaultAction: 'approve',
  });
});
