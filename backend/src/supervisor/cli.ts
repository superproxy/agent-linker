#!/usr/bin/env node
/**
 * linkagent 单机进程管理器 CLI（仅编排拉起，不常驻守护）：
 *   tsx src/supervisor/cli.ts start   [all|gateway|weixin|weixin:<id>|node]  后台拉起（默认 all）
 *   tsx src/supervisor/cli.ts stop    [all|gateway|weixin|weixin:<id>|node]  停止
 *   tsx src/supervisor/cli.ts restart [all|gateway|weixin|weixin:<id>|node]  重启
 *   tsx src/supervisor/cli.ts status                            查看进程状态（含微信多账号实例）
 *   tsx src/supervisor/cli.ts logs    [all|gateway|weixin|weixin:<id>|node]  跟随日志（默认 all）
 *   tsx src/supervisor/cli.ts foreground [target]               前台联调（Ctrl-C 一起退出）
 *
 * weixin 多账号：仅 weixin.accounts（扫码绑定的登录用户）有实例。
 * start/stop/restart weixin 作用于全部已绑定账号；未绑定则跳过微信进程。
 * 也可单独操作 weixin:<accountId>（pid/日志独立）。
 * 启动顺序：gateway 健康检查通过后再起 weixin、node；停止反序。
 */
import { watch } from 'node:fs';
import { readFileSync } from 'node:fs';
import {
  ProcessManager,
  parseTargets,
  type ProcessInstanceId,
} from './manager.js';

const USAGE = `用法: linkagent-pm <start|stop|restart|status|logs|foreground> [all|gateway|weixin|weixin:<accountId>|node]`;

/** 跨平台 tail -f：先打印文件末尾，再 watch 增量（零依赖） */
function followLogs(pm: ProcessManager, ids: ProcessInstanceId[]): void {
  const positions = new Map<ProcessInstanceId, number>();

  const printTail = (id: ProcessInstanceId, lines: number): void => {
    try {
      const text = readFileSync(pm.logFile(id), 'utf8');
      const arr = text.split('\n');
      const tail = arr.slice(Math.max(0, arr.length - lines - 1)).join('\n');
      if (tail.trim()) process.stdout.write(prefix(id, tail));
      positions.set(id, text.length);
    } catch {
      positions.set(id, 0);
    }
  };

  const prefix = (id: ProcessInstanceId, chunk: string): string =>
    chunk
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `[${id}] ${l}`)
      .join('\n') + '\n';

  for (const id of ids) printTail(id, 40);

  for (const id of ids) {
    let retry: NodeJS.Timeout | null = null;
    const watcher = watch(pm.logFile(id), { persistent: true }, () => {
      try {
        const text = readFileSync(pm.logFile(id), 'utf8');
        const pos = positions.get(id) ?? 0;
        if (text.length > pos) {
          process.stdout.write(prefix(id, text.slice(pos)));
          positions.set(id, text.length);
        } else if (text.length < pos) {
          // 日志被截断/轮转
          positions.set(id, 0);
        }
      } catch {
        /* 文件暂时不可读，下个事件重试 */
      }
    });
    watcher.on('error', () => {
      // 日志文件尚不存在：1s 后重试挂载
      retry = setInterval(() => {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        if (retry) clearInterval(retry);
        followLogs(pm, [id]);
      }, 1000);
    });
  }

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

async function main(): Promise<void> {
  const [command, targetArg] = process.argv.slice(2);
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    console.log(USAGE);
    return;
  }

  const pm = new ProcessManager();

  switch (command) {
    case 'start':
      await pm.start(parseTargets(targetArg));
      break;
    case 'stop':
      await pm.stop(parseTargets(targetArg));
      break;
    case 'restart':
      await pm.restart(parseTargets(targetArg));
      break;
    case 'status':
      pm.printStatus();
      break;
    case 'logs': {
      const ids = targetArg ? pm.expand(parseTargets(targetArg)) : pm.allInstanceIds();
      console.log(`→ 跟随日志 ${ids.join(', ')}（Ctrl-C 退出，不影响后台进程）`);
      followLogs(pm, ids);
      break;
    }
    case 'foreground': {
      const ids = targetArg ? pm.expand(parseTargets(targetArg)) : pm.allInstanceIds();
      await pm.foreground(ids);
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('错误:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
