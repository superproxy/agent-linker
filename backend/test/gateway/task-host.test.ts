import assert from 'node:assert/strict';
import test from 'node:test';
import { domainToASCII, domainToUnicode } from 'node:url';
import { decodeHostname } from '../../../shared/src/task-host.ts';
import { matchTaskHost, taskCodeServerOrigin, taskIdeOrigin, taskLabelFromHostname, taskViewOrigins } from '../../../web/src/lib/task-host.ts';

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
  assert.equal(taskLabelFromHostname('a.b.localhost'), null);
  assert.equal(taskLabelFromHostname('127.0.0.1'), null);
});

test('matchTaskHost 同时接受下划线和连字符', () => {
  const tasks = [{ id: 't_41db7238' }, { id: 'default' }];
  assert.equal(matchTaskHost(tasks, 't-41db7238')?.id, 't_41db7238');
  assert.equal(matchTaskHost(tasks, 'default')?.id, 'default');
  assert.equal(matchTaskHost(tasks, 'missing'), undefined);
});

test('taskIdeOrigin 使用任务名称和任务号做主机名', () => {
  assert.equal(taskIdeOrigin('默认', 'default'), 'http://默认-default-web.localhost:8088/');
  assert.equal(taskIdeOrigin('test', 't_41db7238'), 'http://test-t-41db7238-web.localhost:8088/');
  assert.equal(taskCodeServerOrigin('test', 't_41db7238'), 'http://test-t-41db7238-ide.localhost:8088/');
});

test('taskViewOrigins 给出嵌套 IDE 与任务 Web', () => {
  assert.deepEqual(taskViewOrigins({ id: 'default', name: '默认' }), {
    ide: 'http://默认-default-ide.localhost:8088/',
    web: 'http://默认-default-web.localhost:8088/',
  });
  assert.deepEqual(taskViewOrigins({ id: '  ', name: '空' }), { ide: 'http://localhost:8088/', web: null });
});
