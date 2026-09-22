/**
 * 默认任务 cwd 注入 .skills/linkagent-tasks/SKILL.md；凭据经启动 pi 的 LINKAGENT_* env，不落盘。
 * 身份是登录用户级（web/<username> + pat_），不是微信 peer、也不是任务 k_。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGIN_TASK_CHANNEL } from './types.js';

export function readTaskSkillMarkdown(installRoot: string): string | undefined {
  const paths = [
    join(installRoot, 'skills', 'linkagent-tasks', 'SKILL.md'),
    join(installRoot, 'server', 'skills', 'linkagent-tasks', 'SKILL.md'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return undefined;
}

export const SKILL_HEADER = 'x-linkagent-skill';

export function isSkillRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers[SKILL_HEADER] ?? headers['X-LinkAgent-Skill'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = (v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export interface TaskSkillIdentity {
  baseUrl: string;
  channel: string;
  userId: string;
  ownerUsername: string;
  taskId: string;
  taskKey: string;
  tokenKind: 'personal';
  token: string;
}

/** 只写 skill 说明（无密钥）。默认任务凭据走启动 pi 的 env，不落盘 identity.json。 */
export function writeTaskSkillMarkdown(cwd: string, markdown: string): void {
  const root = cwd.trim();
  if (!root || !markdown.trim()) return;
  const skillDir = join(root, '.skills', 'linkagent-tasks');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
}

/** 启动 pi 时注入的用户级凭据（不进 agents[].env，按会话 overlay，避免用户间串扰） */
export function taskSkillProcessEnv(identity: TaskSkillIdentity): Record<string, string> {
  return {
    LINKAGENT_BASE_URL: identity.baseUrl,
    LINKAGENT_CHANNEL: identity.channel,
    LINKAGENT_USER_ID: identity.userId,
    LINKAGENT_OWNER: identity.ownerUsername,
    LINKAGENT_TOKEN: identity.token,
    LINKAGENT_TOKEN_KIND: identity.tokenKind,
    LINKAGENT_TASK_ID: identity.taskId,
  };
}

/** 测试/手动回退：skill + identity.json（生产默认任务不写 identity，利于节点扩展） */
export function writeTaskSkillFiles(cwd: string, markdown: string, identity: TaskSkillIdentity): void {
  writeTaskSkillMarkdown(cwd, markdown);
  const identDir = join(cwd.trim(), '.linkagent');
  mkdirSync(identDir, { recursive: true });
  writeFileSync(join(identDir, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
}

export function identityForLoginTask(input: {
  baseUrl: string;
  username: string;
  taskId: string;
  taskKey: string;
  token: string;
}): TaskSkillIdentity {
  const username = input.username.trim();
  return {
    baseUrl: input.baseUrl.replace(/\/$/, ''),
    channel: LOGIN_TASK_CHANNEL,
    userId: username,
    ownerUsername: username,
    taskId: input.taskId,
    taskKey: input.taskKey,
    tokenKind: 'personal',
    token: input.token,
  };
}
