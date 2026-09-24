import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeAgentInfos, defaultSharedConfig } from '@linkagent/shared';

test('buildNodeAgentInfos：从 gateway.agents 合并 permissionMode 到自报清单', () => {
  const cfg = defaultSharedConfig();
  cfg.gateway.agents = [
    {
      id: 'cursor',
      type: 'cursor',
      permissionMode: 'approve-all',
      permissionPolicy: { defaultAction: 'approve' },
    },
    { id: 'pi', type: 'pi', permissionMode: 'approve-reads' },
  ];
  const infos = buildNodeAgentInfos(cfg, ['cursor', 'pi', 'unknown']);
  const cursor = infos.find((a) => a.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.permissionMode, 'approve-all');
  assert.deepEqual(cursor.permissionPolicy, { defaultAction: 'approve' });
  const pi = infos.find((a) => a.id === 'pi');
  assert.equal(pi?.permissionMode, 'approve-reads');
  const unknown = infos.find((a) => a.id === 'unknown');
  assert.ok(unknown);
  assert.equal(unknown.permissionMode, undefined);
});
