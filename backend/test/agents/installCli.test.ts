import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGuideFor } from '../../src/gateway/agents/acpEngine.js';
import { AgentInstallError, runAgentInstall } from '../../src/gateway/agents/installCli.js';

test('installGuideFor：npx 类型可 npm 全局安装；cursor 仅展示', () => {
  const codex = installGuideFor('codex');
  assert.equal(codex.command, 'npm i -g @agentclientprotocol/codex-acp');
  assert.ok(codex.argv && codex.argv.includes('@agentclientprotocol/codex-acp'));

  const cursorWin = installGuideFor('cursor', 'win32');
  assert.ok(cursorWin.command.includes('cursor.com/install'));
  assert.equal(cursorWin.argv, undefined);

  const cursorPosix = installGuideFor('cursor', 'linux');
  assert.ok(cursorPosix.command.startsWith('curl '));
  assert.equal(cursorPosix.argv, undefined);
});

test('runAgentInstall：未知类型 / 不可代执行抛错；白名单 argv 走 spawn', async () => {
  await assert.rejects(() => runAgentInstall('ghost'), (err: unknown) => {
    assert.ok(err instanceof AgentInstallError);
    assert.equal(err.code, 'invalid_request');
    return true;
  });
  await assert.rejects(() => runAgentInstall('cursor'), (err: unknown) => {
    assert.ok(err instanceof AgentInstallError);
    assert.equal(err.code, 'install_not_runnable');
    return true;
  });

  const seen: string[][] = [];
  const result = await runAgentInstall('zcode', {
    spawn: async (file, args) => {
      seen.push([file, ...args]);
      return { exitCode: 0, stdout: 'installed', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'installed');
  assert.ok(seen[0]?.includes('zcode-acp-server'));
});
