import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConfigHost, containerEnvText, dockerRunArgs, envFileFor, readDotenv, shouldBuildImage, userWorkspaceHost } from '../../../code-server/node-docker/ctl.mjs';

test('shouldBuildImage：只在缺省镜像不存在时构建', () => {
  assert.equal(shouldBuildImage('linkagent-node:local', false), true);
  assert.equal(shouldBuildImage('linkagent-node:local', true), false);
  assert.equal(shouldBuildImage('other:latest', false), false);
});

test('envFileFor：没有 node.env 时用 example', () => {
  const exists = (path) => path.endsWith('node.env.example');
  assert.match(envFileFor('/opt/node-docker', exists), /node\.env\.example$/);
  const preferEnv = (path) => path.endsWith('node.env') || path.endsWith('node.env.example');
  assert.match(envFileFor('/opt/node-docker', preferEnv), /node\.env$/);
});

test('containerEnvText 去掉宿主机专用项', () => {
  const text = containerEnvText(readDotenv(`
LINKAGENT_GATEWAY_URL=ws://host.docker.internal:8787
LINKAGENT_WORKSPACE=D:/work/repo
LINKAGENT_NODE_IMAGE=linkagent-node:local
ARK_API_KEY=
FRPS_TOKEN=secret
`));
  assert.match(text, /LINKAGENT_GATEWAY_URL=ws:\/\/host\.docker\.internal:8787/);
  assert.match(text, /FRPS_TOKEN=secret/);
  assert.doesNotMatch(text, /LINKAGENT_WORKSPACE/);
  assert.doesNotMatch(text, /LINKAGENT_NODE_IMAGE/);
  assert.doesNotMatch(text, /ARK_API_KEY/);
  assert.doesNotMatch(containerEnvText(readDotenv('LINKAGENT_AGENT_HOME=C:/Users/me/.pi\n')), /LINKAGENT_AGENT_HOME/);
});

test('userWorkspaceHost：只拼单层用户名', () => {
  assert.match(userWorkspaceHost('D:/work/workspace', 'alice'), /workspace[/\\]alice$/);
  assert.throws(() => userWorkspaceHost('D:/work/workspace', ''), /单层用户名/);
  assert.throws(() => userWorkspaceHost('D:/work/workspace', '../alice'), /单层用户名/);
  assert.throws(() => userWorkspaceHost('D:/work/workspace', 'alice/task'), /单层用户名/);
});

test('agentConfigHost：缺省用用户目录下的 .pi', () => {
  assert.match(agentConfigHost('', 'C:/Users/me'), /[/\\]\.pi$/);
  assert.match(agentConfigHost('D:/cfg/pi', 'C:/Users/me'), /D:[/\\]cfg[/\\]pi$/);
});

test('dockerRunArgs：后台挂工作目录和节点状态', () => {
  const args = dockerRunArgs({
    foreground: false,
    name: 'linkagent-node',
    envFile: 'C:/cfg/container.env',
    workspace: 'D:\\work\\repo',
    agentHome: 'C:\\Users\\me\\.pi',
    stateDir: 'D:\\state',
    image: 'linkagent-node:local',
  });
  assert.equal(args[0], 'run');
  assert.equal(args.includes('-p'), false);
  assert.ok(args.includes('-d'));
  assert.ok(args.includes('--restart'));
  assert.ok(args.includes('-w'));
  assert.ok(args.includes('/root/workspace'));
  assert.ok(args.includes('D:/work/repo:/root/workspace'));
  assert.ok(args.includes('C:/Users/me/.pi:/root/.pi'));
  assert.ok(args.includes('D:/state:/var/lib/linkagent/node'));
  assert.equal(args.at(-1), 'linkagent-node:local');
});

test('dockerRunArgs：有 frpc.toml 时只读挂入', () => {
  const args = dockerRunArgs({
    foreground: true,
    name: 'linkagent-node',
    envFile: '/tmp/container.env',
    workspace: '/work',
    agentHome: '/home/me/.pi',
    stateDir: '/state',
    frpcFile: '/cfg/frpc.toml',
    image: 'linkagent-node:local',
  });
  assert.ok(args.includes('--rm'));
  assert.equal(args.includes('-d'), false);
  assert.ok(args.some((arg) => arg.endsWith(':/etc/linkagent/frpc.toml:ro')));
});
