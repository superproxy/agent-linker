import { useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import { AuthClient, type UserPublic } from '../api';
import { DEFAULT_BASE, LS_KEY, readToken } from '../lib/constants';

export function ChangePasswordModal(props: {
  open: boolean;
  user: UserPublic;
  forced?: boolean;
  onDone: (u: UserPublic) => void;
  onLogout: () => void;
  onClose?: () => void;
}) {
  const base = localStorage.getItem(LS_KEY) ?? DEFAULT_BASE;
  const client = new AuthClient(base);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setOldPwd('');
    setNewPwd('');
    setConfirm('');
    setErr(null);
  };

  const submit = async () => {
    if (busy) return;
    if (newPwd.length < 8) return setErr('新密码长度至少 8 位');
    if (newPwd !== confirm) return setErr('两次输入的新密码不一致');
    if (newPwd === oldPwd) return setErr('新密码不能与旧密码相同');
    setBusy(true);
    setErr(null);
    try {
      await client.changePassword(readToken(), oldPwd, newPwd);
      props.onDone({ ...props.user, mustChangePassword: false });
      reset();
      props.onClose?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title={props.forced ? '首次登录请修改密码' : '修改密码'}
      closable={!props.forced}
      maskClosable={false}
      onCancel={() => {
        if (props.forced) props.onLogout();
        else {
          reset();
          props.onClose?.();
        }
      }}
      okText="确认修改"
      cancelText={props.forced ? '退出登录' : '取消'}
      confirmLoading={busy}
      onOk={() => void submit()}
      okButtonProps={{ disabled: !oldPwd || !newPwd || !confirm }}
    >
      {props.forced ? (
        <Alert
          type="info"
          showIcon
          message="为了账号安全，使用默认密码首次登录必须修改密码后才能继续。"
          style={{ marginBottom: 14 }}
        />
      ) : null}
      <Form layout="vertical">
        <Form.Item label="原密码" required>
          <Input.Password value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoFocus />
        </Form.Item>
        <Form.Item label="新密码（至少 8 位）" required>
          <Input.Password value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
        </Form.Item>
        <Form.Item label="确认新密码" required>
          <Input.Password value={confirm} onChange={(e) => setConfirm(e.target.value)} onPressEnter={() => void submit()} />
        </Form.Item>
      </Form>
      {err ? <Alert type="error" showIcon message={err} /> : null}
    </Modal>
  );
}
