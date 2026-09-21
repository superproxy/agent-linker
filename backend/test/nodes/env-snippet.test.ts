import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNodeEnv } from '../../../web/src/lib/node-env.ts';

const fields = {
  gatewayUrl: 'wss://gw.example.com:8787',
  token: "nt_abc'def",
  agents: 'opencode,pi',
};

test('formatNodeEnv dotenv：KEY=VALUE，供写入 node.env', () => {
  assert.equal(
    formatNodeEnv(fields, 'dotenv'),
    ["LINKAGENT_GATEWAY_URL=wss://gw.example.com:8787", "LINKAGENT_GATEWAY_TOKEN=nt_abc'def", 'LINKAGENT_NODE_AGENTS=opencode,pi'].join(
      '\n',
    ),
  );
});

test('formatNodeEnv bash：export + 单引号转义', () => {
  const out = formatNodeEnv(fields, 'bash');
  assert.equal(
    out,
    [
      "export LINKAGENT_GATEWAY_URL='wss://gw.example.com:8787'",
      "export LINKAGENT_GATEWAY_TOKEN='nt_abc'\\''def'",
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
