/**
 * core.channel.commands —— 文本控制命令检测 / 命令鉴权（对齐 openclaw）
 */

export type CommandGatingModeWhenAccessGroupsOff = 'allow' | 'deny' | 'configured';

export interface CommandAuthorizer {
  configured: boolean;
  allowed: boolean;
}

const CONTROL_COMMAND_ALIASES: Array<{ aliases: string[]; acceptsArgs?: boolean }> = [
  { aliases: ['/new', '/newchat', '/clear'], acceptsArgs: true },
  { aliases: ['/reset'], acceptsArgs: true },
  { aliases: ['/stop', '/abort', '/cancel', '/halt'] },
  { aliases: ['/help', '/status'] },
];

/** 对齐 openclaw hasControlCommand：命中控制命令别名（含参数变体） */
export function hasControlCommand(text: string, _cfg?: unknown): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  for (const command of CONTROL_COMMAND_ALIASES) {
    for (const alias of command.aliases) {
      if (lowered === alias) return true;
      if (command.acceptsArgs && lowered.startsWith(alias)) {
        const nextChar = trimmed.charAt(alias.length);
        if (nextChar && /\s/.test(nextChar)) return true;
      }
    }
  }
  return false;
}

/** 对齐 openclaw：粗粒度判断消息是否需要计算命令鉴权（宁多勿少） */
export function shouldComputeCommandAuthorized(text: string, cfg?: unknown, _options?: unknown): boolean {
  if (!text?.trim()) return false;
  if (hasControlCommand(text, cfg)) return true;
  // 行内指令令牌（如 "hey /status"）
  if (/(?:^|\s)[/!][a-z]/i.test(text)) return true;
  return false;
}

/** 对齐 openclaw resolveCommandAuthorizedFromAuthorizers（含 useAccessGroups 关闭时的 mode 策略） */
export function resolveCommandAuthorizedFromAuthorizers(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? 'allow';
  if (!useAccessGroups) {
    if (mode === 'allow') return true;
    if (mode === 'deny') return false;
    if (!authorizers.some((entry) => entry.configured)) return true;
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

/** 对齐 openclaw resolveControlCommandGate */
export function resolveControlCommandGate(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): { commandAuthorized: boolean; shouldBlock: boolean } {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers(params);
  return {
    commandAuthorized,
    shouldBlock: params.allowTextCommands && params.hasControlCommand && !commandAuthorized,
  };
}
