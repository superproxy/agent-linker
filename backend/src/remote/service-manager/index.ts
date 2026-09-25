import type { FastifyInstance } from 'fastify';
import { exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execAsync = promisify(exec);

export interface ServiceInfo {
  pid: number;
  name: string;
  cmd: string;
  cpu: number;
  memory: number;
  status: 'running' | 'stopped';
}

export interface PortInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  pid: number;
  processName: string;
  address: string;
}

export class ServiceManager {
  registerRoutes(app: FastifyInstance) {
    // 获取系统状态
    app.get('/api/system/info', async (req, reply) => {
      try {
        // CPU使用率
        const cpuUsageCmd = await execAsync('top -bn1 | grep "Cpu(s)" | awk \'{print 100 - $8}\'');
        const cpuUsage = parseFloat(cpuUsageCmd.stdout.trim()) || 0;

        // 内存信息
        const memTotalMB = os.totalmem() / 1024 / 1024;
        const memFreeMB = os.freemem() / 1024 / 1024;
        const memUsedMB = memTotalMB - memFreeMB;

        // 磁盘信息
        const diskCmd = await execAsync('df -h / | tail -n 1 | awk \'{print $2,$3,$4,$5}\'');
        const parts = diskCmd.stdout.trim().split(/\s+/);
        const diskTotal = parts[0] || '0';
        const diskUsed = parts[1] || '0';
        const diskFree = parts[2] || '0';
        const diskPercent = parts[3] || '0%';

        return {
          cpu: {
            usage: cpuUsage.toFixed(2),
            count: os.cpus().length
          },
          memory: {
            total: Math.round(memTotalMB),
            used: Math.round(memUsedMB),
            free: Math.round(memFreeMB),
            usagePercent: ((memUsedMB / memTotalMB) * 100).toFixed(2)
          },
          os: {
            platform: os.platform(),
            hostname: os.hostname(),
            uptime: os.uptime()
          },
          disk: {
            total: diskTotal,
            used: diskUsed,
            free: diskFree,
            usagePercent: diskPercent.replace('%', '')
          },
          loadAvg: os.loadavg()
        };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '获取系统信息失败' });
      }
    });

    // 获取进程列表
    app.get('/api/processes', async (req, reply) => {
      try {
        const { stdout } = await execAsync('ps -eo pid,comm,%cpu,%mem,cmd --sort=-%cpu | head -50');
        const lines = stdout.trim().split('\n').slice(1);
        
        const processes: ServiceInfo[] = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0] || '0');
          const cpu = parseFloat(parts[2] || '0');
          const memory = parseFloat(parts[3] || '0');
          const name = parts[1] || 'unknown';
          const cmd = parts.slice(4).join(' ');
          return { pid, name, cmd, cpu, memory, status: 'running' as const };
        });

        return { processes };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '获取进程列表失败' });
      }
    });

    // 终止进程
    app.post('/api/processes/kill', async (req, reply) => {
      const { pid, signal = 'SIGTERM' } = req.body as { pid: number; signal?: string };
      
      try {
        process.kill(pid, signal as NodeJS.Signals);
        return { success: true };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '终止进程失败' });
      }
    });

    // 获取端口占用列表
    app.get('/api/ports', async (req, reply) => {
      try {
        const { stdout } = await execAsync('netstat -tulpn 2>/dev/null | grep LISTEN');
        const lines = stdout.trim().split('\n').filter(Boolean);
        
        const ports: PortInfo[] = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          const protocol = parts[0] as 'tcp' | 'udp';
          const address = parts[3] || '';
          const port = parseInt(address.split(':').pop() || '0');
          const pidProcess = parts[6] || '';
          const [pid, processName] = pidProcess.split('/');
          
          return {
            port,
            protocol,
            pid: parseInt(pid || '0'),
            processName: processName || 'unknown',
            address
          };
        }).filter(p => p.port > 0);

        return { ports };
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : '获取端口列表失败' });
      }
    });

    // 管理systemd服务
    app.post('/api/service/systemd', async (req, reply) => {
      const { action, serviceName } = req.body as { action: 'start' | 'stop' | 'restart' | 'status'; serviceName: string };
      
      try {
        const { stdout, stderr } = await execAsync(`systemctl ${action} ${serviceName} 2>&1`);
        return {
          success: true,
          output: stdout + stderr
        };
      } catch (err) {
        return reply.status(500).send({ 
          error: err instanceof Error ? err.message : '操作服务失败',
          output: (err as any).stderr || ''
        });
      }
    });

    // 执行自定义命令（仅限白名单命令，后续可加权限控制）
    app.post('/api/service/exec', async (req, reply) => {
      const { command } = req.body as { command: string };
      // 白名单命令，防止恶意执行
      const allowedCommands = ['ls', 'ps', 'netstat', 'df', 'free', 'uptime', 'top -bn1', 'journalctl -n 100'];
      const isAllowed = allowedCommands.some(cmd => command.startsWith(cmd));
      
      if (!isAllowed) {
        return reply.status(403).send({ error: '命令不在白名单中' });
      }

      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 10000 });
        return {
          success: true,
          stdout,
          stderr
        };
      } catch (err) {
        return reply.status(500).send({ 
          error: err instanceof Error ? err.message : '执行命令失败',
          stdout: (err as any).stdout || '',
          stderr: (err as any).stderr || ''
        });
      }
    });
  }
}

export const serviceManager = new ServiceManager();
