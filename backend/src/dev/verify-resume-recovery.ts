import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeStore } from 'acpx/runtime';
import { PiWrapper } from '../gateway/agents/acpWrapper.js';
import { defaultAgentDefinitions } from '@linkagent/shared';
import type { AgentDefinition } from '@linkagent/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/**
 * 回归验证：persistent 会话「后端侧会话状态失效 → 恢复失败 → 自动重置记录并新建会话续聊」。
 * 步骤：
 *  1. PiWrapper 第一轮创建持久会话（sessionKey=t-recover），正常回复；
 *  2. 改写 acpx 记录 agentSessionId 为无效值（模拟 pi 侧会话文件被清理/session-map 丢失）；
 *  3. 新 PiWrapper 实例同 sessionKey 再发一轮，应自动重置并新建会话成功回复，
 *     且 onText 收到「会话上下文已失效」提示。
 * 用法：pnpm verify-resume-recovery
 */
async function main() {
  const base = defaultAgentDefinitions().find((d) => d.type === 'pi');
  if (!base) throw new Error('缺 pi agent 定义');
  const def: AgentDefinition = { ...base, id: 'pi', cwd: repoRoot, permissionMode: 'approve-reads' };

  const stateDir = mkdtempSync(join(tmpdir(), 'acpx-resume-recovery-'));
  const sessionKey = 't-recover';

  try {
    console.log('→ 第一轮：创建 persistent 会话（pi）…');
    const w1 = new PiWrapper({ definition: def, stateDir, verbose: process.env.VERBOSE === '1' });
    let out1 = '';
    await w1.chat(
      { sessionKey, messages: [{ role: 'user', content: '只回复两个字：好的' }] },
      { onText: (d) => (out1 += d), onReasoning: () => {}, onToolActivity: () => {} },
      AbortSignal.timeout(120_000),
    );
    console.log('  第一轮回复:', JSON.stringify(out1.slice(0, 60)));
    if (!out1.trim()) throw new Error('第一轮无输出');
    await w1.dispose();

    console.log('→ 模拟后端侧会话状态丢失：改写记录 agentSessionId 为无效值…');
    const store = createRuntimeStore({ stateDir });
    const rec = await store.load(sessionKey);
    if (!rec) throw new Error('未找到持久会话记录');
    // 模拟后端侧会话状态丢失：acpSessionId（pi 侧 sessionId）指向不存在的会话
    rec.acpSessionId = '00000000-0000-0000-0000-000000000000';
    await store.save(rec);

    console.log('→ 第二轮：同 sessionKey 恢复（应自动重置记录并新建会话）…');
    const w2 = new PiWrapper({ definition: def, stateDir, verbose: process.env.VERBOSE === '1' });
    let out2 = '';
    let notice = false;
    await w2.chat(
      { sessionKey, messages: [{ role: 'user', content: '只回复两个字：收到' }] },
      {
        onText: (d) => {
          if (d.includes('会话上下文已失效')) notice = true;
          out2 += d;
        },
        onReasoning: () => {},
        onToolActivity: () => {},
      },
      AbortSignal.timeout(120_000),
    );
    await w2.dispose();
    console.log('  第二轮输出:', JSON.stringify(out2.slice(0, 120)));

    const pass = notice && out2.trim().length > 0;
    console.log(pass ? '\n✅ 恢复失败自动重置重试验证通过' : '\n❌ 验证失败');
    process.exit(pass ? 0 : 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ verify 失败:', err instanceof Error ? err.message : err);
  if (process.env.VERBOSE) console.error(err);
  process.exit(1);
});
