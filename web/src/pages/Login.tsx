import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { ApiOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';

export function LoginPage(props: {
  base: string;
  error?: string;
  onApplyBase: (next: string) => void;
  onLogin: (u: string, p: string) => Promise<string | null>;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [baseDraft, setBaseDraft] = useState(props.base);
  const [err, setErr] = useState<string | null>(props.error ?? null);
  const [busy, setBusy] = useState(false);

  const applyBase = () => {
    const url = baseDraft.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(url)) {
      setErr('网关地址需以 http:// 或 https:// 开头');
      return;
    }
    props.onApplyBase(url);
  };

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setErr(null);
    const e = await props.onLogin(username.trim(), password);
    if (e) setErr(e);
    setBusy(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-logo">◆</div>
          <h1>linkagent 后台</h1>
          <p>多渠道 Agent 网关运维控制台</p>
        </div>

        <Form layout="vertical" onFinish={() => void submit()} requiredMark={false}>
          <Form.Item label="网关地址">
            <Input
              size="large"
              prefix={<ApiOutlined style={{ color: 'rgba(229,233,240,0.35)' }} />}
              value={baseDraft}
              onChange={(e) => setBaseDraft(e.target.value)}
              spellCheck={false}
              onPressEnter={applyBase}
              addonAfter={
                <Button type="link" size="small" style={{ padding: 0 }} onClick={applyBase}>
                  切换
                </Button>
              }
            />
          </Form.Item>
          <Form.Item label="用户名">
            <Input
              size="large"
              prefix={<UserOutlined style={{ color: 'rgba(229,233,240,0.35)' }} />}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          </Form.Item>
          <Form.Item label="密码">
            <Input.Password
              size="large"
              prefix={<LockOutlined style={{ color: 'rgba(229,233,240,0.35)' }} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              placeholder="默认 admin / admin123"
            />
          </Form.Item>

          {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 14 }} /> : null}

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={busy}
            disabled={!username.trim() || !password}
          >
            登录
          </Button>
          <p className="sub-muted" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            初始管理员 admin / admin123，首次登录需修改密码
          </p>
        </Form>
      </div>
    </div>
  );
}
