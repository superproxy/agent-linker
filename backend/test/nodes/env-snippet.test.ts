import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNodeEnv,
  formatNodeLaunchSnippet,
  formatNodePmCommand,
  nodeEnvFilePath,
  suggestNodeInstanceName,
} from '../../../web/src/lib/node-env.ts';

const fields = {
  gatewayUrl: 'wss://gw.example.com:8787',
  token: "nt_abc'def",
  agents: 'opencode,pi',
  nodeName: 'builder-01',
  nodeId: 'n_abc123xyz',
};

test('formatNodeEnv dotenv：KEY=VALUE，供写入 node.env', () => {
  assert.equal(
    formatNodeEnv(fields, 'dotenv'),
    [
      'LINKAGENT_GATEWAY_URL=wss://gw.example.com:8787',
      "LINKAGENT_GATEWAY_TOKEN=nt_abc'def",
      'LINKAGENT_NODE_NAME=builder-01',
      'LINKAGENT_NODE_ID=n_abc123xyz',
      'LINKAGENT_NODE_AGENTS=opencode,pi',
    ].join('\n'),
  );
});

test('formatNodeEnv bash：export + 单引号转义', () => {
  const out = formatNodeEnv(fields, 'bash');
  assert.equal(
    out,
    [
      "export LINKAGENT_GATEWAY_URL='wss://gw.example.com:8787'",
      "export LINKAGENT_GATEWAY_TOKEN='nt_abc'\\''def'",
      "export LINKAGENT_NODE_NAME='builder-01'",
      "export LINKAGENT_NODE_ID='n_abc123xyz'",
      "export LINKAGENT_NODE_AGENTS='opencode,pi'",
    ].join('\n'),
  );
});

test('formatNodeEnv powershell：$env: + 单引号翻倍', () => {
  const out = formatNodeEnv(fields, 'powershell');
  assert.equal(
    out,
    [
      "$env:LINKAGENT_GATEWAY_URL='wss://gw.example.com:8787'",
      "$env:LINKAGENT_GATEWAY_TOKEN='nt_abc''def'",
      "$env:LINKAGENT_NODE_NAME='builder-01'",
      "$env:LINKAGENT_NODE_ID='n_abc123xyz'",
      "$env:LINKAGENT_NODE_AGENTS='opencode,pi'",
    ].join('\n'),
  );
});

test('formatNodeEnv 无 token 时省略 TOKEN 行', () => {
  const noTok = { gatewayUrl: 'ws://127.0.0.1:8787', agents: 'pi' };
  assert.equal(formatNodeEnv(noTok, 'dotenv'), 'LINKAGENT_GATEWAY_URL=ws://127.0.0.1:8787\nLINKAGENT_NODE_AGENTS=pi');
  assert.ok(!formatNodeEnv(noTok, 'bash').includes('TOKEN'));
  assert.ok(!formatNodeEnv(noTok, 'powershell').includes('TOKEN'));
});

test('formatNodePmCommand 与 nodeEnvFilePath', () => {
  assert.equal(formatNodePmCommand('start', 'n1'), 'pnpm worker:start n1');
  assert.equal(formatNodePmCommand('restart', 'n1'), 'pnpm worker:restart n1');
  assert.equal(formatNodePmCommand('dev'), 'pnpm worker:dev');
  assert.equal(nodeEnvFilePath('builder'), '.runtime-state/node-builder.env');
  assert.equal(nodeEnvFilePath(), '.runtime-state/node.env');
});

test('formatNodeLaunchSnippet bash：env 与 restart 同一粘贴块', () => {
  const out = formatNodeLaunchSnippet(fields, 'bash', 'restart', 'builder-01');
  assert.ok(out.includes("export LINKAGENT_GATEWAY_URL="));
  assert.ok(out.endsWith('pnpm worker:restart builder-01'));
});

test('formatNodeLaunchSnippet dotenv：附 env 路径注释', () => {
  const out = formatNodeLaunchSnippet(fields, 'dotenv', 'start', 'n1');
  assert.ok(out.includes('.runtime-state/node-n1.env'));
  assert.ok(out.includes('pnpm worker:start n1'));
});

test('suggestNodeInstanceName', () => {
  assert.equal(suggestNodeInstanceName({ name: 'my-builder', nodeId: 'n_x' }), 'my-builder');
  assert.equal(
    suggestNodeInstanceName({ name: 'a'.repeat(60), nodeId: 'n_abcdefghijkl' }),
    'abcdefghijkl',
  );
});
