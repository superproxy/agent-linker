import type { AgentPlugin } from '../plugin-manager.js';
import type { CommandType, SystemStatus, ProcessEntry } from '../../protocol/index.js';
import { cpus, totalmem, freemem, uptime } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const OS = process.platform as 'linux' | 'darwin' | 'win32';

const SystemManagerPlugin: AgentPlugin = {
  name: 'system-manager',
  description: '系统管理插件，支持进程管理、服务管理、系统状态监控',
  version: '1.0.0',
  supportedCommands: [
    'process:list', 'process:kill', 'service:list', 'service:start', 'service:stop', 'system:status'
  ] as CommandType[],

  async handleCommand(command: CommandType, params: Record<string, any>) {
    switch (command) {
      case 'process:list': {
        let output: string;
        if (OS === 'win32') {
          output = (await execAsync('wmic process get ProcessId,Name,CommandLine,WorkingSetSize,UserModeTime,CreationDate')).stdout;
          return parseWindowsProcessList(output);
        } else {
          output = (await execAsync('ps -eo pid,comm,cmd,%cpu,%mem,user,lstart')).stdout;
          return parseUnixProcessList(output);
        }
      }

      case 'process:kill': {
        const { pid, signal = 'SIGTERM' } = params;
        process.kill(pid, signal as NodeJS.Signals);
        return { success: true, pid };
      }

      case 'system:status': {
        const cpuUsage = await getCpuUsage();
        const totalMemory = totalmem();
        const freeMemory = freemem();
        const usedMemory = totalMemory - freeMemory;
        const disks = await getDiskUsage();
        return {
          cpu: {
            usage: cpuUsage,
            cores: cpus().length,
            model: cpus()[0].model,
          },
          memory: {
            total: totalMemory,
            used: usedMemory,
            free: freeMemory,
            usage: Math.round((usedMemory / totalMemory) * 100),
          },
          disk: disks,
          network: { rxBytes: 0, txBytes: 0 },
          uptime: uptime(),
        } as SystemStatus;
      }

      case 'service:list': {
        if (OS === 'win32') {
          const { stdout } = await execAsync('sc query type= service state= all');
          return parseWindowsServices(stdout);
        } else if (OS === 'linux') {
          const { stdout } = await execAsync('systemctl list-units --type=service --all --no-pager --no-legend');
          return parseSystemdServices(stdout);
        } else {
          const { stdout } = await execAsync('launchctl list');
          return parseLaunchdServices(stdout);
        }
      }

      case 'service:start': {
        const { name } = params;
        if (OS === 'win32') {
          await execAsync(`net start "${name}"`);
        } else if (OS === 'linux') {
          await execAsync(`systemctl start ${name}`);
        } else {
          await execAsync(`launchctl start ${name}`);
        }
        return { success: true, name };
      }

      case 'service:stop': {
        const { name } = params;
        if (OS === 'win32') {
          await execAsync(`net stop "${name}"`);
        } else if (OS === 'linux') {
          await execAsync(`systemctl stop ${name}`);
        } else {
          await execAsync(`launchctl stop ${name}`);
        }
        return { success: true, name };
      }

      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  },

  testCases: [
    {
      name: '获取系统状态',
      command: 'system:status',
      params: {},
      expect: (res) => res.cpu && res.memory && res.disk,
    },
    {
      name: '获取进程列表',
      command: 'process:list',
      params: {},
      expect: (res) => Array.isArray(res) && res.length > 0,
    },
    {
      name: '获取服务列表',
      command: 'service:list',
      params: {},
      expect: (res) => Array.isArray(res),
    },
  ],
};

async function getCpuUsage(): Promise<number> {
  const start = cpus().map(cpu => cpu.times);
  await new Promise(resolve => setTimeout(resolve, 100));
  const end = cpus().map(cpu => cpu.times);
  
  const usage = end.map((cpu, i) => {
    const startCpu = start[i];
    const idle = cpu.idle - startCpu.idle;
    const total = Object.values(cpu).reduce((a, b) => a + b, 0) - Object.values(startCpu).reduce((a, b) => a + b, 0);
    return 1 - (idle / total);
  });

  return Math.round(usage.reduce((a, b) => a + b, 0) / usage.length * 100;
}

async function getDiskUsage() {
  if (OS === 'win32') {
    const { stdout } = await execAsync('wmic logicaldisk get Size,FreeSpace,Name');
    return stdout.trim().split('\n').slice(1)
      .filter(line => line.trim())
      .map(line => {
        const [free, size, name] = line.trim().split(/\s+/);
        return {
          total: parseInt(size || '0'),
          used: parseInt(size || '0') - parseInt(free || '0'),
          free: parseInt(free || '0'),
          usage: size ? Math.round(((parseInt(size) - parseInt(free || '0')) / parseInt(size) * 100) : 0,
          mountPoint: name,
        };
      })
      .filter(d => d.total > 0);
  } else {
    const { stdout } = await execAsync('df -kP');
    return stdout.trim().split('\n').slice(1)
      .filter(line => line.startsWith('/'))
      .map(line => {
        const [, total, used, free, usage, mountPoint] = line.trim().split(/\s+/);
        return {
          total: parseInt(total) * 1024,
          used: parseInt(used) * 1024,
          free: parseInt(free) * 1024,
          usage: parseInt(usage),
          mountPoint,
        };
      });
  }
}

function parseUnixProcessList(output: string): ProcessEntry[] {
  const lines = output.trim().split('\n').slice(1);
  return lines.map(line => {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[0]);
    const name = parts[1];
    const cpu = parseFloat(parts[3]);
    const memory = parseFloat(parts[4]);
    const user = parts[5];
    const cmdline = parts.slice(6).join(' ');
    return { pid, name, cmdline, cpu, memory, user, startTime: 0 };
  }).filter(p => !isNaN(p.pid));
}

function parseWindowsProcessList(output: string): ProcessEntry[] {
  const lines = output.trim().split('\n').slice(1);
  return lines.map(line => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) return null;
    const pid = parseInt(parts[0]);
    const name = parts[1];
    const cmdline = parts[2] || '';
    return { pid, name, cmdline, cpu: 0, memory: parseInt(parts[3]) / 1024, user: '', startTime: 0 };
  }).filter(Boolean) as ProcessEntry[];
}

function parseWindowsServices(output: string) {
  const services = output.trim().split(/\r?\n\r?\n/);
  return services.map(s => {
    const lines = s.trim().split('\n');
    const name = lines.find(l => l.startsWith('SERVICE_NAME:'))?.split(':')[1].trim() || '';
    const state = lines.find(l => l.startsWith('STATE'))?.split(':')[1].trim() || '';
    return { name, state: state.includes('RUNNING') ? 'running' : 'stopped' };
  }).filter(s => s.name);
}

function parseSystemdServices(output: string) {
  const lines = output.trim().split('\n');
  return lines.map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      name: parts[0],
      loadState: parts[1],
      activeState: parts[2],
      subState: parts[3],
      description: parts.slice(4).join(' '),
    };
  });
}

function parseLaunchdServices(output: string) {
  const lines = output.trim().split('\n').slice(1);
  return lines.map(line => {
    const [pid, status, label] = line.trim().split(/\s+/);
    return {
      name: label,
      pid: pid === '-' ? null : parseInt(pid),
      status: parseInt(status) === 0 ? 'running' : 'stopped',
    };
  });
}

export default SystemManagerPlugin;
