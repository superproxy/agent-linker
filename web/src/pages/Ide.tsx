import { useCallback, useEffect, useMemo, useState } from 'react';
import { Breadcrumb, Button, Card, Input, Space, Tabs, Tag, Typography } from 'antd';
import { FolderOpenOutlined, FileOutlined, ReloadOutlined } from '@ant-design/icons';
import { ApiClient, type IdeFileEntry, type IdeTaskScope } from '../api';
import type { TabId } from '../lib/constants';
import type { AuthErrorHandler } from '../lib/hooks';
import { confirmAsync, notify } from '../lib/notify';
import { taskViewOrigins } from '../lib/task-host';
import { ChatPage } from './Chat';
import type { ChatSession } from './types';

const { Text } = Typography;

interface IdePageProps {
  base: string;
  token: string;
  onAuthError: AuthErrorHandler;
  onGoTab?: (t: TabId) => void;
  /** 从任务进入时绑定该任务的对话，文件与终端使用任务目录 */
  session?: ChatSession | null;
}

function commandForFile(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return `python "${path}"`;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return `node "${path}"`;
  if (lower.endsWith('.ts') || lower.endsWith('.mts')) return `npx tsx "${path}"`;
  if (lower.endsWith('.ps1')) return `powershell -NoProfile -File "${path}"`;
  if (lower.endsWith('.sh')) return `sh "${path}"`;
  return '';
}

function joinPath(dir: string, name: string): string {
  const clean = name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.includes('..') || clean.includes('/')) return '';
  return dir ? `${dir}/${clean}` : clean;
}

export function IdePage({ base, token, onAuthError, session = null }: IdePageProps) {
  const client = useMemo(() => new ApiClient(base, token), [base, token]);
  const scope = useMemo<IdeTaskScope | undefined>(
    () => (session?.taskId ? { taskId: session.taskId, owner: session.ownerUsername } : undefined),
    [session?.taskId, session?.ownerUsername],
  );
  const workspaceLabel = session ? `任务 ${session.taskName}` : '工作区';
  const [dir, setDir] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<IdeFileEntry[]>([]);
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [command, setCommand] = useState('');
  const [termOut, setTermOut] = useState(
    session
      ? `工作目录为任务「${session.taskName}」的目录。命令在该目录下执行。`
      : '工作目录为 IDE 工作区。命令在该目录下执行。',
  );
  const [running, setRunning] = useState(false);
  const [debugCommand, setDebugCommand] = useState('');
  const [debugStdout, setDebugStdout] = useState('');
  const [debugStderr, setDebugStderr] = useState('');
  const [debugCode, setDebugCode] = useState<number | null>(null);
  const [debugging, setDebugging] = useState(false);

  const fail = useCallback(
    (e: unknown) => {
      if (onAuthError(e)) return;
      notify.error(e instanceof Error ? e.message : String(e));
    },
    [onAuthError],
  );

  const loadDir = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const data = await client.ideList(path, scope);
        setDir(data.path);
        setParent(data.parent);
        setEntries(data.entries);
      } catch (e) {
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [client, fail, scope],
  );

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  const openFile = async (entry: IdeFileEntry) => {
    if (entry.isDirectory) {
      await loadDir(entry.path);
      return;
    }
    if (dirty) {
      const ok = await confirmAsync({ title: '当前文件未保存', content: '继续打开将丢弃未保存内容。', okText: '继续' });
      if (!ok) return;
    }
    try {
      const data = await client.ideRead(entry.path, scope);
      setFilePath(data.path);
      setContent(data.content);
      setDirty(false);
    } catch (e) {
      fail(e);
    }
  };

  const save = async () => {
    if (!filePath) {
      notify.error('先打开或新建一个文件');
      return;
    }
    setSaving(true);
    try {
      await client.ideWrite(filePath, content, scope);
      setDirty(false);
      notify.success('已保存');
      await loadDir(dir);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const createFile = async () => {
    const path = joinPath(dir, newName);
    if (!path) {
      notify.error('文件名不能包含路径');
      return;
    }
    try {
      await client.ideWrite(path, '', scope);
      setNewName('');
      setFilePath(path);
      setContent('');
      setDirty(false);
      await loadDir(dir);
    } catch (e) {
      fail(e);
    }
  };

  const createDir = async () => {
    const path = joinPath(dir, newName);
    if (!path) {
      notify.error('目录名不能包含路径');
      return;
    }
    try {
      await client.ideMkdir(path, scope);
      setNewName('');
      await loadDir(dir);
    } catch (e) {
      fail(e);
    }
  };

  const removeEntry = async (entry: IdeFileEntry) => {
    const ok = await confirmAsync({
      title: `删除 ${entry.name}？`,
      content: entry.isDirectory ? '将删除该目录及其内容。' : '将删除该文件。',
      okText: '删除',
      okButtonProps: { danger: true },
    });
    if (!ok) return;
    try {
      await client.ideDelete(entry.path, scope);
      if (filePath === entry.path) {
        setFilePath('');
        setContent('');
        setDirty(false);
      }
      await loadDir(dir);
    } catch (e) {
      fail(e);
    }
  };

  const execDebug = async (line: string) => {
    const cmd = line.trim();
    if (!cmd) return;
    setDebugging(true);
    setDebugCommand(cmd);
    try {
      const result = await client.ideExec(cmd, scope);
      setDebugStdout(result.stdout);
      setDebugStderr(result.stderr);
      setDebugCode(result.code);
    } catch (e) {
      fail(e);
    } finally {
      setDebugging(false);
    }
  };

  const run = async () => {
    const line = command.trim();
    if (!line) return;
    setRunning(true);
    setTermOut((prev) => `${prev}\n$ ${line}\n`);
    try {
      const result = await client.ideExec(line, scope);
      const chunk = `${result.stdout}${result.stderr}${result.code === 0 ? '' : `\n退出码 ${result.code}`}`;
      setTermOut((prev) => prev + chunk);
      setCommand('');
    } catch (e) {
      fail(e);
    } finally {
      setRunning(false);
    }
  };

  const crumbs = dir ? dir.split('/') : [];
  const views = taskViewOrigins(session ? { id: session.taskId, name: session.taskName } : null);

  return (
    <div className="ide-page">
      <Tabs
        className="ide-tabs"
        defaultActiveKey={session ? 'chat' : 'files'}
        items={[
          {
            key: 'chat',
            label: '对话',
            children: (
              <ChatPage
                base={base}
                token={token}
                onAuthError={onAuthError}
                session={session}
                onClearSession={() => undefined}
                embedded
              />
            ),
          },
          {
            key: 'ide-view',
            label: 'IDE',
            children: (
              <div className="ide-frame-wrap">
                <iframe className="ide-frame" title={`任务 IDE ${views.ide}`} src={views.ide} />
              </div>
            ),
          },
          {
            key: 'web-view',
            label: 'Web',
            children: views.web ? (
              <div className="ide-frame-wrap">
                <iframe className="ide-frame" title={`任务开发页 ${views.web}`} src={views.web} />
              </div>
            ) : (
              <Card size="small" title="Web">
                <Text type="secondary">从任务进入在线 IDE 后，这里展示该任务的 npm run dev。</Text>
              </Card>
            ),
          },
          {
            key: 'vnc-view',
            label: 'VNC',
            children: views.vnc ? (
              <div className="ide-frame-wrap">
                <iframe className="ide-frame" title={`任务 VNC ${views.vnc}`} src={views.vnc} />
              </div>
            ) : (
              <Card size="small" title="VNC">
                <Text type="secondary">从任务进入在线 IDE 后，这里展示该任务的 VNC。</Text>
              </Card>
            ),
          },
          {
            key: 'files',
            label: '文件浏览',
            children: (
              <div className="ide-body">
                <Card
                  className="ide-side"
                  size="small"
                  title={workspaceLabel}
                  extra={
                    <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadDir(dir)} />
                  }
                >
                  {session?.cwd ? (
                    <Text type="secondary" ellipsis={{ tooltip: session.cwd }} style={{ display: 'block', marginBottom: 8 }}>
                      {session.cwd}
                    </Text>
                  ) : null}
                  <Breadcrumb
                    items={[
                      { title: <a onClick={() => void loadDir('')}>{workspaceLabel}</a> },
                      ...crumbs.map((name, index) => {
                        const path = crumbs.slice(0, index + 1).join('/');
                        return { title: <a onClick={() => void loadDir(path)}>{name}</a> };
                      }),
                    ]}
                  />
                  {parent !== null ? (
                    <div style={{ marginTop: 8 }}>
                      <Button type="link" size="small" onClick={() => void loadDir(parent)}>
                        返回上级
                      </Button>
                    </div>
                  ) : null}
                  <Space.Compact style={{ width: '100%', margin: '8px 0' }}>
                    <Input
                      placeholder="新建名称"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                    <Button onClick={() => void createFile()}>文件</Button>
                    <Button onClick={() => void createDir()}>目录</Button>
                  </Space.Compact>
                  {entries.map((entry) => (
                    <div key={entry.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      <Button type="text" style={{ flex: 1, textAlign: 'left' }} onClick={() => void openFile(entry)}>
                        {entry.isDirectory ? <FolderOpenOutlined /> : <FileOutlined />} {entry.name}
                      </Button>
                      <Button type="link" danger size="small" onClick={() => void removeEntry(entry)}>
                        删除
                      </Button>
                    </div>
                  ))}
                  {entries.length === 0 ? <Text type="secondary">此目录是空的</Text> : null}
                </Card>
                <Card
                  className="ide-main"
                  size="small"
                  title={filePath || '未打开文件'}
                  extra={
                    <Button type="primary" loading={saving} disabled={!filePath} onClick={() => void save()}>
                      保存
                    </Button>
                  }
                >
                  <Input.TextArea
                    className="ide-editor"
                    value={content}
                    disabled={!filePath}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setDirty(true);
                    }}
                    autoSize={{ minRows: 18, maxRows: 28 }}
                  />
                </Card>
              </div>
            ),
          },
          {
            key: 'debug',
            label: '调试',
            children: (
              <Card size="small" title="调试" extra={filePath ? <Text code>{filePath}</Text> : <Text type="secondary">未打开文件</Text>}>
                <Text type="secondary">在工作区目录执行命令，标准输出和标准错误分开显示。</Text>
                <Space.Compact style={{ width: '100%', marginTop: 12 }}>
                  <Input
                    placeholder="调试命令"
                    value={debugCommand}
                    onChange={(e) => setDebugCommand(e.target.value)}
                    onPressEnter={() => void execDebug(debugCommand)}
                  />
                  <Button
                    disabled={!filePath}
                    onClick={() => {
                      const cmd = commandForFile(filePath);
                      if (!cmd) {
                        notify.error('这个文件没有预设运行命令，请自行输入');
                        return;
                      }
                      void execDebug(cmd);
                    }}
                  >
                    运行当前文件
                  </Button>
                  <Button type="primary" loading={debugging} onClick={() => void execDebug(debugCommand)}>
                    执行
                  </Button>
                </Space.Compact>
                <div style={{ marginTop: 12 }}>
                  {debugCode === null ? (
                    <Text type="secondary">尚未执行</Text>
                  ) : (
                    <Tag color={debugCode === 0 ? 'success' : 'error'}>退出码 {debugCode}</Tag>
                  )}
                </div>
                <Text type="secondary">标准输出</Text>
                <pre className="ide-term">{debugStdout || '（空）'}</pre>
                <Text type="secondary">标准错误</Text>
                <pre className="ide-term">{debugStderr || '（空）'}</pre>
              </Card>
            ),
          },
          {
            key: 'terminal',
            label: '终端',
            children: (
              <Card size="small" title="工作区终端">
                <pre className="ide-term">{termOut}</pre>
                <Space.Compact style={{ width: '100%', marginTop: 12 }}>
                  <Input
                    placeholder="输入命令后回车"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onPressEnter={() => void run()}
                  />
                  <Button type="primary" loading={running} onClick={() => void run()}>
                    执行
                  </Button>
                </Space.Compact>
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
