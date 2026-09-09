/**
 * 临时诊断：验证 persistent 会话生命周期修复。
 *  1. 带 sessionKey 的 persistent 请求结束后 → pi 进程应保持常驻（不立即关闭）
 *  2. 空闲超过 persistentIdleTimeoutMs（本脚本用 8s）→ 进程应被自动关闭
 *  3. 同一 sessionKey 再请求 → 进程重新拉起、记忆可恢复（续聊）
 *
 * 用法：pnpm tsx src/dev/diag-persistent-idle.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { AcpAdapter } from '../gateway/agents/opencode.js';
import { defaultAgentDefinitions } from '@linkagent/shared';
import type { AgentDefinition } from '@linkagent/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const IDLE_MS = 8_000;

function piProcesses(): number {
  try {
    const out = execSync('pgrep -f "pi-acp" | wc -l', { encoding: 'utf8' }).trim();
    return Number(out);
  } catch {
    return 0;
  }
}

function snapshot(label: string): void {
  const acp = execSync('pgrep -f "pi-acp" | wc -l', { encoding: 'utf8' }).trim();
  const pi = execSync('pgrep -f "pi --mode rpc" | wc -l', { encoding: 'utf8' }).trim();
  console.log(`[snapshot @${label}] pi-acp=${acp} pi-rpc=${pi}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(adapter: AcpAdapter, sessionKey: string, msg: string): Promise<string> {
  let text = '';
  await adapter.chat(
    { sessionKey, messages: [{ role: 'user', content: msg }] },
    {
      onText: (d) => (text += d),
      onReasoning: () => {},
      onToolActivity: () => {},
      onSessionId: () => {},
    },
    AbortSignal.timeout(120_000),
  );
  return text.trim();
}

async function main() {
  const agent = 'pi';
  const base = defaultAgentDefinitions().find((d) => d.type === agent);
  if (!base) throw new Error(`缺默认 agent 定义: ${agent}`);
  const def: AgentDefinition = {
    ...base,
    id: agent,
    description: 'diag-persistent-idle',
    permissionMode: 'approve-reads',
    cwd: repoRoot,
  };
  if (process.env.PI_MODEL) def.model = process.env.PI_MODEL;

  const adapter = new AcpAdapter({
    definition: def,
    stateDir: join(repoRoot, '.runtime-state', 'acpx'),
    persistentIdleTimeoutMs: IDLE_MS,
    verbose: process.env.VERBOSE === '1',
  });

  const key = `diag-persistent-${Date.now()}`;
  console.log('=== 1) persistent 首轮请求（应拉起 pi 进程，结束后进程应保留）===');
  console.log('→', await chat(adapter, key, '回复两个字：收到'));
  await sleep(1_500);
  snapshot('首轮结束+1.5s');
  const after1 = piProcesses();
  console.log(after1 > 0 ? '✅ 进程常驻（未被立即关闭）' : '❌ 进程已被关闭');

  console.log('\n=== 2) 空闲 8s 后（应自动关闭进程）===');
  await sleep(IDLE_MS + 2_000);
  snapshot('空闲超时+2s');
  const after2 = piProcesses();
  console.log(after2 < after1 ? '✅ 空闲超时后进程已关闭' : '⚠️ 进程数未减少，需检查');

  console.log('\n=== 3) 同 sessionKey 再请求（应重新拉起并恢复记忆）===');
  console.log('→', await chat(adapter, key, '我刚才让你回复哪两个字？只答这两个字'));
  await sleep(1_500);
  snapshot('续聊结束+1.5s');

  console.log('\n=== 4) dispose（应清理全部 persistent 进程）===');
  await adapter.dispose();
  await sleep(1_000);
  snapshot('dispose 后');
  console.log(piProcesses() === 0 ? '✅ 全部关闭' : '⚠️ 仍有进程残留');

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ 诊断失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
