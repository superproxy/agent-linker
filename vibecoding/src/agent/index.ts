import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { platform, arch, hostname } from 'node:os';
import {
  MessageType,
  type BaseMessage,
  type AgentRegisterPayload,
  type ServerRequestPayload,
} from '../protocol/index.js';
import { PluginManager } from './plugin-manager.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const SERVER_URL = process.env.VIBECODING_SERVER || 'ws://127.0.0.1:9999';
const AGENT_ID = process.env.VIBECODING_AGENT_ID || `agent-${uuidv4().slice(0, 8)}`;
const AGENT_NAME = process.env.VIBECODING_AGENT_NAME || hostname();
const OS = platform() as 'linux' | 'darwin' | 'win32';
const ARCH = arch() as 'x64' | 'arm64' | 'ia32';
const HOSTNAME = hostname();
// 中继模式配置
const RELAY_ENABLED = process.env.VIBECODING_RELAY_ENABLED === 'true';
const RELAY_PORT = process.env.VIBECODING_RELAY_PORT ? parseInt(process.env.VIBECODING_RELAY_PORT) : 9998;
const RELAY_ALLOW_SUBNETS = process.env.VIBECODING_RELAY_ALLOW_SUBNETS?.split(',') || ['0.0.0.0/0']; // 允许的子Agent网段

console.log(`VibeCoding agent starting, connecting to ${SERVER_URL}...`);
console.log(`Agent ID: ${AGENT_ID}, Name: ${AGENT_NAME}, OS: ${OS}, Arch: ${ARCH}`);

let ws: WebSocket;
let heartbeatTimer: NodeJS.Timeout | null = null;
// 中继模式下的子Agent连接: subAgentId -> { ws, info }
const subAgents = new Map<string, { ws: WebSocket; info: Agent }>();
let relayWss: WebSocketServer | null = null;

const SUPPORTED_COMMANDS: CommandType[] = [
  // 文件管理
  'file:list', 'file:read', 'file:write', 'file:delete', 'file:rename', 'file:mkdir', 'file:stat',
  // 进程管理
  'process:list', 'process:kill', 'system:status',
  // 服务管理（Windows/Linux/macOS适配）
  'service:list', 'service:start', 'service:stop',
  // 远程桌面
  'desktop:screenshot',
];

// 启动中继服务（如果开启）
function startRelayServer() {
  if (!RELAY_ENABLED) return;
  const { WebSocketServer } = await import('ws');
  relayWss = new WebSocketServer({ port: RELAY_PORT, host: '0.0.0.0' });
  console.log(`[relay] 中继服务已启动，子Agent连接端口: ${RELAY_PORT}`);

  relayWss.on('connection', (subWs, req) => {
    const clientIp = req.socket.remoteAddress || '';
    console.log(`[relay] 新的子Agent连接: ${clientIp}`);
    let currentSubAgentId: string | null = null;

    subWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        // 子Agent注册到中继Agent
        if (message.type === 'agent:register') {
          const subAgentInfo: Agent = {
            ...message.payload,
            parentAgentId: AGENT_ID,
            online: true,
            lastSeen: Date.now(),
            isRelay: message.payload.isRelay || false,
          };
          currentSubAgentId = subAgentInfo.agentId;
          subAgents.set(currentSubAgentId, { ws: subWs, info: subAgentInfo });
          // 上报到服务端
          sendMessage(MessageType.AGENT_SUBAGENT_REGISTER, { subAgent: subAgentInfo });
          // 返回注册成功给子Agent
          subWs.send(JSON.stringify({
            type: 'server:agent:registered',
            payload: { agentId: subAgentInfo.agentId, serverTime: Date.now() },
          }));
          console.log(`[relay] 子Agent注册成功: ${subAgentInfo.agentId} (${subAgentInfo.agentName})`);
        }
        // 子Agent心跳
        else if (message.type === 'agent:heartbeat') {
          if (currentSubAgentId && subAgents.has(currentSubAgentId)) {
            const subAgent = subAgents.get(currentSubAgentId)!;
            subAgent.info.lastSeen = Date.now();
            subAgent.info.systemLoad = message.payload.systemLoad;
            sendMessage(MessageType.AGENT_SUBAGENT_HEARTBEAT, {
              subAgentId: currentSubAgentId,
              systemLoad: message.payload.systemLoad,
            });
          }
        }
        // 子Agent返回命令结果，转发给服务端
        else if (message.type === 'agent:response') {
          sendMessage(MessageType.AGENT_RELAY_MESSAGE, {
            subAgentId: currentSubAgentId,
            originalMessage: message,
          });
        }
        // 子Agent的其他消息直接中转
        else {
          sendMessage(MessageType.AGENT_RELAY_MESSAGE, {
            subAgentId: currentSubAgentId,
            originalMessage: message,
          });
        }
      } catch (err) {
        console.error(`[relay] 子Agent消息解析错误: ${err}`);
      }
    });

    subWs.on('close', () => {
      if (currentSubAgentId && subAgents.has(currentSubAgentId)) {
        subAgents.delete(currentSubAgentId);
        sendMessage(MessageType.AGENT_SUBAGENT_DISCONNECT, { subAgentId: currentSubAgentId });
        console.log(`[relay] 子Agent断开: ${currentSubAgentId}`);
      }
    });
  });
}

function connect() {
  ws = new WebSocket(SERVER_URL);

  ws.on('open', async () => {
    console.log('Connected to VibeCoding server');
    // 注册Agent
    const registerPayload: AgentRegisterPayload = {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      os: OS,
      arch: ARCH,
      hostname: HOSTNAME,
      supportedFeatures: SUPPORTED_COMMANDS,
      isRelay: RELAY_ENABLED,
    };
    sendMessage(MessageType.AGENT_REGISTER, registerPayload);

    // 启动心跳，10秒一次
    heartbeatTimer = setInterval(sendHeartbeat, 10000);

    // 启动中继服务（如果开启）
    if (RELAY_ENABLED) {
      await startRelayServer();
    }
  });

  ws.on('message', async (data) => {
    try {
      const message: BaseMessage<ServerRequestPayload> = JSON.parse(data.toString());
      // 服务端要求中转消息到子Agent
      if (message.type === MessageType.SERVER_RELAY_MESSAGE) {
        await handleRelayMessage(message);
      }
      // 服务端直接发命令给当前Agent
      else if (message.type === MessageType.SERVER_REQUEST && message.requestId) {
        await handleCommand(message.requestId, message.payload.command, message.payload.params);
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server, reconnecting in 3s...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

// 处理服务端转发给子Agent的消息
async function handleRelayMessage(message: any) {
  const { subAgentId, originalMessage } = message.payload;
  if (!subAgents.has(subAgentId)) {
    sendMessage(MessageType.AGENT_RESPONSE, {
      requestId: message.requestId,
      success: false,
      error: 'SubAgent not found',
    });
    return;
  }
  const subWs = subAgents.get(subAgentId)!.ws;
  subWs.send(JSON.stringify(originalMessage));
}

async function handleCommand(requestId: string, command: CommandType, params: Record<string, any>) {
  try {
    let result: any;
    switch (command) {
      // ========== 文件管理 ==========
      case 'file:list': {
        const { path = '.' } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const entries = readdirSync(absPath, { withFileTypes: true });
        result = entries.map((entry): FileEntry => {
          const entryPath = join(absPath, entry.name);
          const stat = statSync(entryPath);
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            mode: stat.mode,
          };
        });
        break;
      }

      case 'file:stat': {
        const { path } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const stat = statSync(absPath);
        result = {
          path: absPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          createdAt: stat.birthtimeMs,
          mode: stat.mode,
        };
        break;
      }

      case 'file:read': {
        const { path, encoding = 'base64' } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        const content = readFileSync(absPath);
        result = encoding === 'base64' ? content.toString('base64') : content.toString(encoding);
        break;
      }

      case 'file:write': {
        const { path, content, encoding = 'base64' } = params;
        const absPath = resolvePath(path);
        const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, encoding);
        writeFileSync(absPath, buffer);
        result = { success: true, path: absPath, size: buffer.length };
        break;
      }

      case 'file:delete': {
        const { path } = params;
        const absPath = resolvePath(path);
        if (!existsSync(absPath)) throw new Error('Path not found');
        if (OS === 'win32') {
          await execAsync(`del /f /s /q "${absPath}"`);
        } else {
          await execAsync(`rm -rf "${absPath}"`);
        }
        result = { success: true };
        break;
      }

      case 'file:rename': {
        const { oldPath, newPath } = params;
        const absOldPath = resolvePath(oldPath);
        const absNewPath = resolvePath(newPath);
        if (!existsSync(absOldPath)) throw new Error('Old path not found');
        renameSync(absOldPath, absNewPath);
        result = { success: true, oldPath: absOldPath, newPath: absNewPath };
        break;
      }

      case 'file:mkdir': {
        const { path, recursive = true } = params;
        const absPath = resolvePath(path);
        mkdirSync(absPath, { recursive });
        result = { success: true, path: absPath };
        break;
      }

      // ========== 进程/系统管理 ==========
      case 'process:list': {
        let output: string;
        if (OS === 'win32') {
          output = (await execAsync('wmic process get ProcessId,Name,CommandLine,WorkingSetSize,UserModeTime,CreationDate')).stdout;
          result = parseWindowsProcessList(output);
        } else {
          output = (await execAsync('ps -eo pid,comm,cmd,%cpu,%mem,user,lstart')).stdout;
          result = parseUnixProcessList(output);
        }
        break;
      }

      case 'process:kill': {
        const { pid, signal = 'SIGTERM' } = params;
        process.kill(pid, signal as NodeJS.Signals);
        result = { success: true, pid };
        break;
      }

      case 'system:status': {
        // CPU使用率
        const cpuUsage = await getCpuUsage();
        // 内存
        const totalMemory = totalmem();
        const freeMemory = freemem();
        const usedMemory = totalMemory - freeMemory;
        // 磁盘
        const disks = await getDiskUsage();
        // 网络
        const network = await getNetworkUsage();

        result = {
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
          network,
          uptime: uptime(),
        } as SystemStatus;
        break;
      }

      // ========== 服务管理 ==========
      case 'service:list': {
        if (OS === 'win32') {
          const { stdout } = await execAsync('sc query type= service state= all');
          result = parseWindowsServices(stdout);
        } else if (OS === 'linux') {
          const { stdout } = await execAsync('systemctl list-units --type=service --all --no-pager --no-legend');
          result = parseSystemdServices(stdout);
        } else { // macOS
          const { stdout } = await execAsync('launchctl list');
          result = parseLaunchdServices(stdout);
        }
        break;
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
        result = { success: true, name };
        break;
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
        result = { success: true, name };
        break;
      }

      // ========== 远程桌面 ==========
      case 'desktop:screenshot': {
        let buffer: Buffer;
        if (OS === 'darwin') {
          // macOS: screencapture
          const tmpPath = `/tmp/screenshot-${Date.now()}.png`;
          await execAsync(`screencapture -x -t png ${tmpPath}`);
          buffer = readFileSync(tmpPath);
          unlinkSync(tmpPath);
        } else if (OS === 'linux') {
          // Linux: import (imagemagick)或者gnome-screenshot
          const tmpPath = `/tmp/screenshot-${Date.now()}.png`;
          try {
            await execAsync(`gnome-screenshot -f ${tmpPath}`);
          } catch {
            await execAsync(`import -window root ${tmpPath}`);
          }
          buffer = readFileSync(tmpPath);
          unlinkSync(tmpPath);
        } else { // Windows
          const tmpPath = `${process.env.TEMP}\\screenshot-${Date.now()}.png`;
          await execAsync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{PRTSC}'); Start-Sleep -Milliseconds 500; $img = [System.Windows.Forms.Clipboard]::GetImage(); $img.Save('${tmpPath}', [System.Drawing.Imaging.ImageFormat]::Png); [System.Windows.Forms.Clipboard]::Clear();"`);
          buffer = readFileSync(tmpPath);
          unlinkSync(tmpPath);
        }
        result = buffer.toString('base64');
        break;
      }

      default:
        throw new Error(`Unsupported command: ${command}`);
    }

    sendMessage(MessageType.AGENT_RESPONSE, {
      requestId,
      success: true,
      data: result,
    });
  } catch (err) {
    console.error(`Command ${command} failed:`, err);
    sendMessage(MessageType.AGENT_RESPONSE, {
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// 辅助函数：路径安全解析，防止目录穿越
function resolvePath(path: string): string {
  const root = parse(process.cwd()).root;
  const resolved = join(root, path);
  if (!resolved.startsWith(root)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

// 辅助函数：获取CPU使用率
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

  return Math.round(usage.reduce((a, b) => a + b, 0) / usage.length * 100);
}

// 辅助函数：获取磁盘使用率
async function getDiskUsage(): Promise<SystemStatus['disk']> {
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
          usage: size ? Math.round(((parseInt(size) - parseInt(free || '0')) / parseInt(size)) * 100) : 0,
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

// 辅助函数：获取网络流量
async function getNetworkUsage(): Promise<SystemStatus['network']> {
  // 简单实现，返回0，生产环境可以用os.networkInterfaces()加/proc/net/dev实现
  return { rxBytes: 0, txBytes: 0 };
}

// 辅助函数：解析Unix进程列表
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
    return { pid, name, cmdline, cpu, memory, user, startTime: 0 } as ProcessEntry;
  }).filter(p => !isNaN(p.pid));
}

// 辅助函数：解析Windows进程列表
function parseWindowsProcessList(output: string): ProcessEntry[] {
  const lines = output.trim().split('\n').slice(1);
  return lines.map(line => {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) return null;
    const pid = parseInt(parts[0]);
    const name = parts[1];
    const cmdline = parts[2] || '';
    return { pid, name, cmdline, cpu: 0, memory: parseInt(parts[3]) / 1024, user: '', startTime: 0 } as ProcessEntry;
  }).filter(Boolean) as ProcessEntry[];
}

// 辅助函数：解析Windows服务列表
function parseWindowsServices(output: string): any[] {
  const services = output.trim().split(/\r?\n\r?\n/);
  return services.map(s => {
    const lines = s.trim().split('\n');
    const name = lines.find(l => l.startsWith('SERVICE_NAME:'))?.split(':')[1].trim() || '';
    const state = lines.find(l => l.startsWith('STATE'))?.split(':')[1].trim() || '';
    return { name, state: state.includes('RUNNING') ? 'running' : 'stopped' };
  }).filter(s => s.name);
}

// 辅助函数：解析systemd服务列表
function parseSystemdServices(output: string): any[] {
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

// 辅助函数：解析launchd服务列表
function parseLaunchdServices(output: string): any[] {
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

// 发送心跳
async function sendHeartbeat() {
  const cpuUsage = await getCpuUsage();
  const totalMem = totalmem();
  const usedMem = totalMem - freemem();
  sendMessage(MessageType.AGENT_HEARTBEAT, {
    agentId: AGENT_ID,
    systemLoad: {
      cpu: cpuUsage,
      memory: Math.round((usedMem / totalMem) * 100),
      disk: 0,
    },
  });
}

function sendMessage<T>(type: MessageType, payload: T, requestId?: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const message: BaseMessage<T> = { type, payload, requestId };
  ws.send(JSON.stringify(message));
}

// 启动连接
connect();
