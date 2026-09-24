import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig } from '@linkagent/shared/config';
import { nodeAgentEntryId, resolveNodeAgentInfos } from '@linkagent/shared';

test('resolveNodeAgentInfos：从 node.agents 对象项合并 permissionMode', () => {
  const nodeAgents = [
    {
      id: 'cursor',
      permissionMode: 'approve-all' as const,
      permissionPolicy: { defaultAction: 'approve' as const },
    },
    'pi',
  ];
  const infos = resolveNodeAgentInfos(nodeAgents, ['cursor', 'pi', 'unknown']);
  const cursor = infos.find((a) => a.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.permissionMode, 'approve-all');
  assert.deepEqual(cursor.permissionPolicy, { defaultAction: 'approve' });
  const pi = infos.find((a) => a.id === 'pi');
  assert.equal(pi?.permissionMode, undefined);
  assert.equal(infos.find((a) => a.id === 'unknown')?.permissionMode, undefined);
});

test('nodeAgentEntryId：字符串与对象项', () => {
  assert.equal(nodeAgentEntryId('Pi'), 'pi');
  assert.equal(nodeAgentEntryId({ id: 'cursor' }), 'cursor');
});

test('migrateConfig：node.agents 对象项含 permissionMode', () => {
  const cfg = migrateConfig({
    gateway: { server: { host: '127.0.0.1', port: 8787 }, auth: { mode: 'local', token: '' }, agents: [] },
    weixin: { enabled: false },
    node: {
      agents: [{ id: 'cursor', permissionMode: 'approve-all' }, 'pi'],
    },
  });
  const cursor = cfg.node.agents.find((a) => nodeAgentEntryId(a) === 'cursor');
  assert.ok(cursor && typeof cursor === 'object');
  if (typeof cursor === 'object') assert.equal(cursor.permissionMode, 'approve-all');
});
