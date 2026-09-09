// 探针：直接连 opencode ACP，dump 所有 turn 事件，确认 thought 流是否存在
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from 'acpx/runtime';
import { mkdirSync } from 'node:fs';

mkdirSync('/tmp/probe-state', { recursive: true });
const runtime = createAcpRuntime({
  cwd: process.cwd(),
  sessionStore: createRuntimeStore({ stateDir: '/tmp/probe-state' }),
  agentRegistry: createAgentRegistry({ overrides: { opencode: ["opencode", "acp"] } }),
  permissionMode: 'approve-reads',
  nonInteractivePermissions: 'deny',
  probeAgent: 'opencode',
  verbose: false,
});

await runtime.probeAvailability();
console.log('[probe] opencode ACP available');

const handle = await runtime.ensureSession({
  sessionKey: 'probe-thought-test',
  agent: 'opencode',
  mode: 'oneshot',
  cwd: process.cwd(),
});

const turn = runtime.startTurn({
  handle,
  text: '9.11 和 9.8 哪个大？请先思考再回答，一句话即可。',
  mode: 'prompt',
  requestId: 'probe-1',
  onElicitation: async () => ({ action: 'decline' }),
});

const seen = new Map();
for await (const ev of turn.events) {
  const key = ev.type === 'text_delta' ? `text_delta[${ev.stream ?? 'no-stream'}]` : ev.type;
  seen.set(key, (seen.get(key) ?? 0) + 1);
  if (key === 'text_delta[thought]') {
    console.log(`  [EV] ${key}: ${JSON.stringify(ev.text).slice(0,200)}`); console.log(`  [THOUGHT] ${JSON.stringify(ev.text).slice(0, 120)}`);
  }
}

console.log('\n[probe] 事件统计:');
for (const [k, v] of seen) console.log(`  ${k}: ${v} 次`);

const result = await turn.result;
console.log(`\n[probe] status=${result.status}`);
await runtime.close({ handle, reason: 'request-complete', discardPersistentState: true }).catch(() => {});
process.exit(0);
