import assert from 'node:assert/strict';
import test from 'node:test';
import { domainToASCII, domainToUnicode } from 'node:url';
import {
  apisixStripsTaskPathBeforeFrps,
  decodeHostname,
  frpcUsesTaskPathLocations,
  resolveLinkagentFrpcMode,
  taskSubdomainHost,
  workspaceFrpTcpRemotePorts,
} from '../../../shared/src/task-host.ts';
import { matchTaskHost, taskCodeServerOrigin, taskDevOrigin, taskIdeOrigin, taskLabelFromHostname, taskViewOrigins, taskVncOrigin } from '../../../web/src/lib/task-host.ts';

function withFrpcModeEnv(mode: string | undefined, run: () => void): void {
  const prevMode = process.env.LINKAGENT_FRPC_MODE;
  const prevTcp = process.env.LINKAGENT_FRPC_TCP_MODE;
  const prevLegacy = process.env.LINKAGENT_FRPC_LEGACY_HOSTS;
  delete process.env.LINKAGENT_FRPC_TCP_MODE;
  delete process.env.LINKAGENT_FRPC_LEGACY_HOSTS;
  if (mode === undefined) delete process.env.LINKAGENT_FRPC_MODE;
  else process.env.LINKAGENT_FRPC_MODE = mode;
  try {
    run();
  } finally {
    if (prevMode === undefined) delete process.env.LINKAGENT_FRPC_MODE;
    else process.env.LINKAGENT_FRPC_MODE = prevMode;
    if (prevTcp === undefined) delete process.env.LINKAGENT_FRPC_TCP_MODE;
    else process.env.LINKAGENT_FRPC_TCP_MODE = prevTcp;
    if (prevLegacy === undefined) delete process.env.LINKAGENT_FRPC_LEGACY_HOSTS;
    else process.env.LINKAGENT_FRPC_LEGACY_HOSTS = prevLegacy;
  }
}

test('resolveLinkagentFrpcMode：MODE 与旧开关', () => {
  withFrpcModeEnv(undefined, () => assert.equal(resolveLinkagentFrpcMode(), 'path'));
  withFrpcModeEnv('tcp', () => assert.equal(resolveLinkagentFrpcMode(), 'tcp'));
  withFrpcModeEnv('legacy', () => assert.equal(resolveLinkagentFrpcMode(), 'legacy'));
  process.env.LINKAGENT_FRPC_TCP_MODE = '1';
  try {
    assert.equal(resolveLinkagentFrpcMode(), 'tcp');
  } finally {
    delete process.env.LINKAGENT_FRPC_TCP_MODE;
  }
  process.env.LINKAGENT_FRPC_LEGACY_HOSTS = '1';
  try {
    assert.equal(resolveLinkagentFrpcMode(), 'legacy');
  } finally {
    delete process.env.LINKAGENT_FRPC_LEGACY_HOSTS;
  }
  process.env.LINKAGENT_FRPC_MODE = 'path';
  process.env.LINKAGENT_FRPC_TCP_MODE = '1';
  try {
    assert.equal(resolveLinkagentFrpcMode(), 'path');
  } finally {
    delete process.env.LINKAGENT_FRPC_MODE;
    delete process.env.LINKAGENT_FRPC_TCP_MODE;
  }
});

test('workspaceFrpTcpRemotePorts：LINKAGENT_FRPC_TCP_PORTS', () => {
  const prev = process.env.LINKAGENT_FRPC_TCP_PORTS;
  process.env.LINKAGENT_FRPC_TCP_PORTS = '21001,21002,21003';
  try {
    assert.deepEqual(workspaceFrpTcpRemotePorts(), { dev: 21001, code: 21002, vnc: 21003 });
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_FRPC_TCP_PORTS;
    else process.env.LINKAGENT_FRPC_TCP_PORTS = prev;
  }
});

test('frpc/APISIX 分工：legacy 时 APISIX 剥路径、frpc 不登记 locations', () => {
  withFrpcModeEnv('legacy', () => {
    assert.equal(frpcUsesTaskPathLocations('ide.localhost'), false);
    assert.equal(apisixStripsTaskPathBeforeFrps('ide.localhost'), true);
    assert.equal(apisixStripsTaskPathBeforeFrps('hubide.ljyd.cn'), true);
  });
  withFrpcModeEnv(undefined, () => {
    assert.equal(frpcUsesTaskPathLocations('ide.localhost'), true);
    assert.equal(apisixStripsTaskPathBeforeFrps('ide.localhost'), false);
  });
});

test('taskSubdomainHost：本机 ide.localhost 与 SaaS apex', () => {
  assert.equal(taskSubdomainHost('', 't_41db7238', 'web', 'ide.localhost'), 't-41db7238-web.ide.localhost');
  assert.equal(taskSubdomainHost('test', 't_41db7238', 'code', 'hubide.ljyd.cn'), 'test-t-41db7238-ide.hubide.ljyd.cn');
});

test('frpc/APISIX 分工：host 子域不登记 locations', () => {
  const prev = process.env.LINKAGENT_TASK_ROUTING;
  process.env.LINKAGENT_TASK_ROUTING = 'host';
  try {
    assert.equal(frpcUsesTaskPathLocations('ide.localhost'), false);
    assert.equal(apisixStripsTaskPathBeforeFrps('ide.localhost'), false);
  } finally {
    if (prev === undefined) delete process.env.LINKAGENT_TASK_ROUTING;
    else process.env.LINKAGENT_TASK_ROUTING = prev;
  }
});

test('frpc/APISIX 分工：tcp 时 frpc 登记 tcp、APISIX 直连 remotePort', () => {
  withFrpcModeEnv('tcp', () => {
    assert.equal(frpcUsesTaskPathLocations('ide.localhost'), false);
    assert.equal(apisixStripsTaskPathBeforeFrps('ide.localhost'), true);
  });
});

test('taskLabelFromHostname 从任务名称-任务号里取出任务号', () => {
  assert.equal(taskLabelFromHostname('默认-default-web.localhost'), 'default');
  assert.equal(taskLabelFromHostname('test-t-41db7238-web.localhost'), 't-41db7238');
  assert.equal(taskLabelFromHostname('test-t_41db7238-web.localhost'), 't_41db7238');
  assert.equal(taskLabelFromHostname('T-41DB7238-WEB.LOCALHOST.'), 't-41db7238');
  assert.equal(taskLabelFromHostname(domainToASCII('默认-default-web.localhost')), 'default');
  assert.equal(decodeHostname(domainToASCII('测试-t-41db7238-web.localhost')), domainToUnicode(domainToASCII('测试-t-41db7238-web.localhost')));
  assert.equal(taskLabelFromHostname('default.localhost'), null);
  assert.equal(taskLabelFromHostname('localhost'), null);
  assert.equal(taskLabelFromHostname('ide.localhost'), null);
  assert.equal(taskLabelFromHostname('default-ide.localhost'), null);
  assert.equal(taskLabelFromHostname('test-t_41db7238-ide.localhost'), null);
  assert.equal(taskLabelFromHostname('default-web.ide.localhost'), 'default');
  assert.equal(taskLabelFromHostname('test-t-41db7238-web.ide.localhost'), 't-41db7238');
  assert.equal(taskLabelFromHostname('a.b.localhost'), null);
  assert.equal(taskLabelFromHostname('127.0.0.1'), null);
});

test('matchTaskHost 同时接受下划线和连字符', () => {
  const tasks = [{ id: 't_41db7238' }, { id: 'default' }];
  assert.equal(matchTaskHost(tasks, 't-41db7238')?.id, 't_41db7238');
  assert.equal(matchTaskHost(tasks, 'default')?.id, 'default');
  assert.equal(matchTaskHost(tasks, 'missing'), undefined);
});

test('taskIdeOrigin 使用正式域名和 taskId-type 路径', () => {
  assert.equal(taskIdeOrigin('默认', 'default'), 'http://ide.localhost:9080/default-web');
  assert.equal(taskIdeOrigin('test', 't_41db7238'), 'http://ide.localhost:9080/t_41db7238-web');
  assert.equal(taskCodeServerOrigin('test', 't_41db7238'), 'http://ide.localhost:9080/t_41db7238-code');
});

test('taskViewOrigins 的 Web 和 VNC 走正式域名路径', () => {
  assert.deepEqual(taskViewOrigins({ id: 'default', name: '默认' }), {
    ide: 'http://ide.localhost:9080/default-code',
    web: taskDevOrigin('默认', 'default'),
    vnc: taskVncOrigin('默认', 'default'),
  });
  assert.equal(taskDevOrigin('test', 't_41db7238'), 'http://ide.localhost:9080/t_41db7238-web');
  assert.equal(
    taskVncOrigin('test', 't_41db7238'),
    'http://ide.localhost:9080/t_41db7238-vnc/vnc.html?autoconnect=1&resize=scale&path=t_41db7238-vnc%2Fwebsockify',
  );
  assert.deepEqual(taskViewOrigins({ id: '  ', name: '空' }), { ide: 'http://ide.localhost:9080/', web: '', vnc: '' });
});
