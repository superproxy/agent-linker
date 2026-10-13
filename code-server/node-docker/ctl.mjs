#!/usr/bin/env node
/**
 * Docker 聚合节点启停。用法与 linkagent-node 的 start.sh 相同：
 *   node ctl.mjs {start|stop|restart|status|log|foreground} [-f <node.env>]
 * 配置（后项覆盖前项，且优先于 shell 环境变量）：
 *   -f / --env-file 指定 dotenv（可多次）；未指定时：
 *   <安装根>/.runtime-state/node.env → code-server/node-docker/node.env
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTAINER_NAME = 'linkagent-node';
export const DEFAULT_IMAGE = 'linkagent-node:local';
/** 容器内 node 的工作目录，对应宿主机 <workspace>/<user>。 */
export const CONTAINER_USER_WORKSPACE = '/root/workspace';
/** 容器内 pi 配置目录，对应宿主机 ~/.pi。 */
export const CONTAINER_AGENT_HOME = '/root/.pi';

export function shouldBuildImage(image, present) {
  return image === DEFAULT_IMAGE && !present;
}
const HOST_ONLY = new Set([
  'LINKAGENT_WORKSPACE',
  'LINKAGENT_NODE_IMAGE',
  'LINKAGENT_NODE_USER',
  'LINKAGENT_AGENT_HOME',
]);

export function agentConfigHost(explicit, homeDir) {
  const raw = String(explicit ?? '').trim();
  if (raw) return resolve(raw);
  return join(homeDir, '.pi');
}

export function userWorkspaceHost(workspaceRoot, user) {
  const name = String(user ?? '').trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('LINKAGENT_NODE_USER 必须是单层用户名');
  }
  return join(workspaceRoot, name);
}

export function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function readDotenv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) continue;
    env[parsed[0]] = parsed[1];
  }
  return env;
}

export function containerEnvText(env) {
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    if (HOST_ONLY.has(key) || value === '') continue;
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function dockerPath(dir) {
  return resolve(dir).replace(/\\/g, '/');
}

export function dockerRunArgs(opts) {
  const args = ['run'];
  if (opts.foreground) args.push('--rm');
  else args.push('-d', '--restart', 'unless-stopped');
  args.push(
    '--name', opts.name,
    '--add-host', 'host.docker.internal:host-gateway',
    '--env-file', opts.envFile,
    '-w', CONTAINER_USER_WORKSPACE,
    '-v', `${dockerPath(opts.workspace)}:${CONTAINER_USER_WORKSPACE}`,
    '-v', `${dockerPath(opts.agentHome)}:${CONTAINER_AGENT_HOME}`,
    '-v', `${dockerPath(opts.stateDir)}:/var/lib/linkagent/node`,
  );
  args.push(opts.image);
  return args;
}

function scriptDir() {
  return dirname(fileURLToPath(import.meta.url));
}

export function envFileFor(dir, exists = existsSync) {
  const file = join(dir, 'node.env');
  if (exists(file)) return file;
  const example = join(dir, 'node.env.example');
  if (exists(example)) return example;
  return '';
}

/** 与 dist/linkagent-node 相同：安装根 .runtime-state/node.env，可选 node-docker/node.env 覆盖宿主机路径。 */
export function nodeEnvConfigPaths(dir, repoRoot = join(dir, '..', '..'), exists = existsSync) {
  const paths = [join(repoRoot, '.runtime-state', 'node.env'), join(dir, 'node.env')];
  return paths.filter((p) => exists(p));
}

/** 与 backend/src/node/env-args.ts 语义一致 */
export function parseNodeEnvFileArgs(argv) {
  const envFiles = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--env-file') {
      const v = argv[i + 1];
      if (!v || String(v).startsWith('-')) {
        return { envFiles: [], rest: [], error: `${a} 需要配置文件路径` };
      }
      envFiles.push(v);
      i++;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-f=')) {
      const v = a.slice(3);
      if (!v) return { envFiles: [], rest: [], error: '-f= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--env-file=')) {
      const v = a.slice('--env-file='.length);
      if (!v) return { envFiles: [], rest: [], error: '--env-file= 需要非空路径' };
      envFiles.push(v);
      continue;
    }
    rest.push(a);
  }
  return { envFiles, rest };
}

export function parseCtlArgv(argv) {
  const parsed = parseNodeEnvFileArgs(argv);
  if (parsed.error) return parsed;
  const positional = parsed.rest;
  const cmd = (positional[0] ?? 'start').toLowerCase();
  return { envFiles: parsed.envFiles, cmd, error: undefined };
}

/** 合并 env 文件；文件中已定义的键不被 shell 里的 LINKAGENT_/FRPS_ 覆盖。 */
export function mergeNodeEnvFromFiles(paths, processEnv = process.env, readFile = readFileSync) {
  const env = {};
  for (const file of paths) {
    Object.assign(env, readDotenv(readFile(file, 'utf8')));
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined || value === '') continue;
    if (!key.startsWith('LINKAGENT_') && key !== 'ARK_API_KEY' && !key.startsWith('FRPS_')) continue;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function loadEnv(dir, explicitEnvFiles) {
  const paths =
    explicitEnvFiles?.length > 0
      ? explicitEnvFiles.map((p) => resolve(p))
      : nodeEnvConfigPaths(dir);
  if (paths.length === 0) {
    const hint = join(dir, 'node.env.example');
    throw new Error(
      `缺少节点配置：请复制 ${hint} 为 <安装根>/.runtime-state/node.env、${join(dir, 'node.env')}，或使用 -f <path>。`,
    );
  }
  return mergeNodeEnvFromFiles(paths);
}

function runDocker(args, inherit) {
  const res = spawnSync('docker', args, {
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

function containerStatus(name) {
  const res = runDocker(['inspect', '-f', '{{.State.Status}}', name], false);
  if (res.status !== 0) return '';
  return res.stdout.trim();
}

function prepare(dir, explicitEnvFiles) {
  const env = loadEnv(dir, explicitEnvFiles);
  const stateDir = join(dir, '.runtime-state');
  const workspaceRoot = resolve(env.LINKAGENT_WORKSPACE || join(dir, 'workspace'));
  const workspace = userWorkspaceHost(workspaceRoot, env.LINKAGENT_NODE_USER);
  const agentHome = agentConfigHost(env.LINKAGENT_AGENT_HOME, homedir());
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentHome, { recursive: true });
  env.LINKAGENT_NODE_WORKSPACE = CONTAINER_USER_WORKSPACE;
  const envFile = join(stateDir, 'container.env');
  writeFileSync(envFile, containerEnvText(env), { encoding: 'utf8', mode: 0o600 });
  return {
    name: CONTAINER_NAME,
    image: env.LINKAGENT_NODE_IMAGE || DEFAULT_IMAGE,
    envFile,
    workspace,
    agentHome,
    stateDir,
  };
}

function imagePresent(image) {
  const res = runDocker(['image', 'inspect', image], false);
  return res.status === 0;
}

function repoRoot() {
  return join(scriptDir(), '..', '..');
}

function buildImage() {
  const root = repoRoot();
  const res = process.platform === 'win32'
    ? spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'build-node.ps1')],
        { cwd: root, stdio: 'inherit', windowsHide: true },
      )
    : spawnSync('bash', [join(root, 'scripts', 'build-node.sh')], {
        cwd: root,
        stdio: 'inherit',
      });
  if (res.error) {
    console.error(res.error.message);
    return 1;
  }
  return res.status ?? 1;
}

function start(dir, foreground, explicitEnvFiles) {
  const status = containerStatus(CONTAINER_NAME);
  if (status === 'running') {
    console.log(`节点已在运行 (容器 ${CONTAINER_NAME})`);
    return 0;
  }
  if (status) runDocker(['rm', '-f', CONTAINER_NAME], false);
  const opts = prepare(dir, explicitEnvFiles);
  if (shouldBuildImage(opts.image, imagePresent(opts.image))) {
    console.log(`→ 构建镜像 ${opts.image} ...`);
    const built = buildImage();
    if (built !== 0) return built;
  }
  console.log(`→ ${foreground ? '前台' : '后台'}启动 ${opts.image} ...`);
  const res = runDocker(dockerRunArgs({ ...opts, foreground }), foreground);
  if (res.error) {
    console.error(res.error.message);
    return 1;
  }
  if (res.status !== 0) {
    const detail = `${res.stderr}${res.stdout}`.trim();
    if (detail) console.error(detail);
    return res.status;
  }
  if (!foreground) console.log(`✅ 节点已启动 (容器 ${CONTAINER_NAME}，日志：start.bat log 或 start.sh log)`);
  return 0;
}

function main() {
  const dir = scriptDir();
  const parsed = parseCtlArgv(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  const { cmd, envFiles } = parsed;
  if (cmd === 'build') process.exit(buildImage());
  if (cmd === 'start' || cmd === 'foreground') {
    process.exit(start(dir, cmd === 'foreground', envFiles));
  }
  if (cmd === 'stop') {
    const status = containerStatus(CONTAINER_NAME);
    if (!status) {
      console.log('Docker 模式节点未在运行');
      process.exit(0);
    }
    const res = runDocker(['rm', '-f', CONTAINER_NAME], false);
    if (res.status !== 0) {
      console.error((res.stderr || res.stdout).trim());
      process.exit(res.status);
    }
    console.log('Docker 模式节点已停止');
    process.exit(0);
  }
  if (cmd === 'restart') {
    runDocker(['rm', '-f', CONTAINER_NAME], false);
    process.exit(start(dir, false, envFiles));
  }
  if (cmd === 'status') {
    const status = containerStatus(CONTAINER_NAME);
    console.log(status ? `容器 ${CONTAINER_NAME} ${status}` : '节点未运行');
    process.exit(0);
  }
  if (cmd === 'log' || cmd === 'logs') {
    const res = runDocker(['logs', '-f', '--tail', '200', CONTAINER_NAME], true);
    process.exit(res.status);
  }
  console.error('用法: node ctl.mjs {build|start|stop|restart|status|log|foreground} [-f <node.env>]');
  process.exit(1);
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (self === entry) main();
