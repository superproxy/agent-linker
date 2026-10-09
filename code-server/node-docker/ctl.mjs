#!/usr/bin/env node
/**
 * Docker 聚合节点启停。用法与 linkagent-node 的 start.sh 相同：
 *   node ctl.mjs {start|stop|restart|status|log|foreground}
 * 配置读同目录 node.env，不覆盖已有环境变量。
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
  if (opts.frpcFile) args.push('-v', `${dockerPath(opts.frpcFile)}:/etc/linkagent/frpc.toml:ro`);
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

function loadEnv(dir) {
  const file = envFileFor(dir);
  if (!file) {
    throw new Error(`缺少 ${join(dir, 'node.env')}。`);
  }
  const fromFile = readDotenv(readFileSync(file, 'utf8'));
  const env = { ...fromFile };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.startsWith('LINKAGENT_') || key === 'ARK_API_KEY' || key.startsWith('FRPS_'))) {
      env[key] = value;
    }
  }
  return env;
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

function prepare(dir) {
  const env = loadEnv(dir);
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
  const frpcFile = join(dir, 'frpc.toml');
  return {
    name: CONTAINER_NAME,
    image: env.LINKAGENT_NODE_IMAGE || DEFAULT_IMAGE,
    envFile,
    workspace,
    agentHome,
    stateDir,
    ...(existsSync(frpcFile) ? { frpcFile } : {}),
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
  const script = join(repoRoot(), 'scripts', 'image-node.mjs');
  const res = spawnSync(process.execPath, [script], {
    cwd: repoRoot(),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (res.error) {
    console.error(res.error.message);
    return 1;
  }
  return res.status ?? 1;
}

function start(dir, foreground) {
  const status = containerStatus(CONTAINER_NAME);
  if (status === 'running') {
    console.log(`节点已在运行 (容器 ${CONTAINER_NAME})`);
    return 0;
  }
  if (status) runDocker(['rm', '-f', CONTAINER_NAME], false);
  const opts = prepare(dir);
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
  if (!foreground) console.log(`✅ 节点已启动 (容器 ${CONTAINER_NAME}，日志：pnpm node:docker:log)`);
  return 0;
}

function main() {
  const cmd = (process.argv[2] ?? 'start').toLowerCase();
  const dir = scriptDir();
  if (cmd === 'build') process.exit(buildImage());
  if (cmd === 'start' || cmd === 'foreground') {
    process.exit(start(dir, cmd === 'foreground'));
  }
  if (cmd === 'stop') {
    const status = containerStatus(CONTAINER_NAME);
    if (!status) {
      console.log('节点未在运行');
      process.exit(0);
    }
    const res = runDocker(['rm', '-f', CONTAINER_NAME], false);
    if (res.status !== 0) {
      console.error((res.stderr || res.stdout).trim());
      process.exit(res.status);
    }
    console.log('节点已停止');
    process.exit(0);
  }
  if (cmd === 'restart') {
    runDocker(['rm', '-f', CONTAINER_NAME], false);
    process.exit(start(dir, false));
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
  console.error('用法: node ctl.mjs {build|start|stop|restart|status|log|foreground}');
  process.exit(1);
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (self === entry) main();
