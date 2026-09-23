import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDisplayName, resolveAcpKindForAgentId } from '../../src/gateway/agents/acpEngine.js';

test('resolveAcpKindForAgentId：已知类型原样返回', () => {
  assert.equal(resolveAcpKindForAgentId('hermes'), 'hermes');
  assert.equal(resolveAcpKindForAgentId('pi'), 'pi');
});

test('resolveAcpKindForAgentId：未知 id 回退 opencode', () => {
  assert.equal(resolveAcpKindForAgentId('not-a-real-agent'), 'opencode');
});

test('resolveAcpKindForAgentId：大小写不敏感', () => {
  assert.equal(resolveAcpKindForAgentId('Hermes'), 'hermes');
  assert.equal(resolveAcpKindForAgentId(' HERMES '), 'hermes');
});

test('agentDisplayName：无 hint 时用 DEFAULT_LABELS（hermes → Hermes）', () => {
  assert.equal(agentDisplayName('hermes'), 'Hermes');
  assert.equal(agentDisplayName('pi'), 'Pi');
  assert.equal(agentDisplayName('hermes', 'Custom'), 'Custom');
});
