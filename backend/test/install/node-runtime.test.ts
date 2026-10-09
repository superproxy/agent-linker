import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNodeLaunch } from '../../../scripts/node-ctl.mjs';

test('resolveNodeLaunch：help 不启动', () => {
  assert.deepEqual(resolveNodeLaunch(['--help'], 'docker'), { help: true });
  assert.deepEqual(resolveNodeLaunch(['help'], undefined), { help: true });
});

test('resolveNodeLaunch：默认原生', () => {
  assert.deepEqual(resolveNodeLaunch(['start'], undefined), { runtime: 'native', args: ['start'] });
  assert.deepEqual(resolveNodeLaunch([], ''), { runtime: 'native', args: ['start'] });
});

test('resolveNodeLaunch：环境变量与命令行开关', () => {
  assert.equal(resolveNodeLaunch(['start'], 'docker').runtime, 'docker');
  assert.equal(resolveNodeLaunch(['stop', '--docker'], 'native').runtime, 'docker');
  assert.deepEqual(resolveNodeLaunch(['stop', '--native'], 'docker'), { runtime: 'native', args: ['stop'] });
  assert.equal(resolveNodeLaunch(['--docker'], undefined).runtime, 'docker');
  assert.match(resolveNodeLaunch(['--docker', '--native'], '').error ?? '', /不能同时/);
  assert.match(resolveNodeLaunch(['start'], 'pod').error ?? '', /native 或 docker/);
});
