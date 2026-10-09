import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piDefaultModelId, resolveTurnModel } from '../../src/gateway/modelcandidates.js';

test('piDefaultModelId：用 defaultProvider 与 defaultModel 合成 providerId/modelId', () => {
  assert.equal(
    piDefaultModelId({ defaultProvider: ' volcengine ', defaultModel: ' deepseek-v4-flash-ga-260731 ' }),
    'volcengine/deepseek-v4-flash-ga-260731',
  );
  assert.equal(piDefaultModelId(null), undefined);
  assert.equal(piDefaultModelId({ defaultProvider: 'volcengine' }), undefined);
  assert.equal(piDefaultModelId({ defaultProvider: 'a/b', defaultModel: 'm' }), undefined);
});

test('resolveTurnModel：显式模型优先；未指定时 pi 用默认，其它 agent 不改', () => {
  const piDefault = () => 'volcengine/deepseek-v4-flash-ga-260731';
  assert.equal(resolveTurnModel('pi', ' anthropic/claude-opus-4-8 ', piDefault), 'anthropic/claude-opus-4-8');
  assert.equal(resolveTurnModel('pi', '  ', piDefault), 'volcengine/deepseek-v4-flash-ga-260731');
  assert.equal(resolveTurnModel('pi', undefined, piDefault), 'volcengine/deepseek-v4-flash-ga-260731');
  assert.equal(resolveTurnModel('pi', undefined, () => '  '), undefined);
  assert.equal(resolveTurnModel('cursor', undefined, piDefault), undefined);
  assert.equal(resolveTurnModel('cursor', 'openai/gpt-5', piDefault), 'openai/gpt-5');
});
