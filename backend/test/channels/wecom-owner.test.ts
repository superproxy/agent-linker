import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWecomOwnerUsername } from '../../src/channels/wecom-owner.js';

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

test('resolveWecomOwnerUsername：显式 wecomOwner 优先', () => {
  const prev = process.env.LINKAGENT_ACCOUNT_ID;
  delete process.env.LINKAGENT_ACCOUNT_ID;
  try {
    assert.equal(resolveWecomOwnerUsername(['a', 'b'], 'alice', noopLog), 'alice');
  } finally {
    if (prev !== undefined) process.env.LINKAGENT_ACCOUNT_ID = prev;
  }
});

test('resolveWecomOwnerUsername：单账号', () => {
  const prev = process.env.LINKAGENT_ACCOUNT_ID;
  delete process.env.LINKAGENT_ACCOUNT_ID;
  try {
    assert.equal(resolveWecomOwnerUsername(['only'], '', noopLog), 'only');
  } finally {
    if (prev !== undefined) process.env.LINKAGENT_ACCOUNT_ID = prev;
  }
});

test('resolveWecomOwnerUsername：LINKAGENT_ACCOUNT_ID', () => {
  const prev = process.env.LINKAGENT_ACCOUNT_ID;
  process.env.LINKAGENT_ACCOUNT_ID = 'env-user';
  try {
    assert.equal(resolveWecomOwnerUsername(['a'], 'b', noopLog), 'env-user');
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_ACCOUNT_ID;
    else process.env.LINKAGENT_ACCOUNT_ID = prev;
  }
});
