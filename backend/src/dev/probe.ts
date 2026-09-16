import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AcpWrapper } from '../gateway/agents/acpWrapper.js';
import { ACP_AGENT_KINDS, defaultAgentDefinitions } from '@linkagent/shared';
import type { AgentDefinition } from '@linkagent/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const SUPPORTED = ACP_AGENT_KINDS;

/**
 * 自检：不经 HTTP，直连 acpx → ACP agent（默认 opencode acp；AGENT=<type> 可换任意支持类型，
 * 如 AGENT=pi 走 pi-acp 桥接、AGENT=workbuddy 走 codebuddy --acp、AGENT=trace-cli 走 traecli acp serve），
 * 发一条读代码库的 prompt，验证「agent 进程可启动 + ACP 会话可建 + 文本可流回 + 读权限放行」整条链路。
 * 用法：pnpm probe；AGENT=pi pnpm probe；AGENT=trace-cli pnpm probe
 */
async function main() {
  const agent = (process.env.AGENT ?? 'opencode') as (typeof SUPPORTED)[number];
  if (!SUPPORTED.includes(agent)) {
    throw new Error(`AGENT 仅支持 ${SUPPORTED.join(' | ')}`);
  }

  const base = defaultAgentDefinitions().find((d) => d.type === agent);
  if (!base) throw new Error(`缺默认 agent 定义: ${agent}`);
  const def: AgentDefinition = {
    ...base,
    id: agent,
    description: 'probe',
    permissionMode: 'approve-reads',
    cwd: repoRoot,
  };
  // 允许用 PI_MODEL 临时覆盖 pi 会话模型
  if (agent === 'pi' && process.env.PI_MODEL) def.model = process.env.PI_MODEL;

  console.log(`→ 启动 ${agent} ACP（acpx oneshot）…`);
  const adapter = new AcpWrapper({
    definition: def,
    stateDir: join(repoRoot, '.runtime-state', 'acpx'),
    verbose: process.env.VERBOSE === '1',
  });

  const started = Date.now();
  let chunks = 0;
  let firstTokenMs = 0;

  const signal = AbortSignal.timeout(180_000);
  await adapter.chat(
    {
      messages: [
        {
          role: 'user',
          content: '请简要回答：当前目录（仓库根）下有哪些顶层文件与目录？只列名称，一句话即可。',
        },
      ],
    },
    {
      onText: (d) => {
        if (chunks === 0) firstTokenMs = Date.now() - started;
        chunks++;
        process.stdout.write(d);
      },
      onReasoning: (d) => process.stdout.write(d),
      onToolActivity: (name) => console.error(`\n[tool] ${name}`),
      onSessionId: (id) => console.error(`\n[session] ${id}`),
    },
    signal,
  );

  const total = Date.now() - started;
  console.error(`\n✅ probe(${agent}) 成功：${chunks} 个 chunk，首 token ${firstTokenMs}ms，总耗时 ${total}ms`);
  await adapter.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ probe 失败:', err instanceof Error ? err.message : err);
  if (process.env.VERBOSE) console.error(err);
  process.exit(1);
});
