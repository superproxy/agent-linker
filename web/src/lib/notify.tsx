import type { ModalFuncProps } from 'antd';
import { App } from 'antd';

type NotifyApi = {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
  warning: (msg: string) => void;
  confirm: (props: ModalFuncProps) => void;
};

let api: NotifyApi | null = null;

/** 在 antd <App> 内部挂载一次，把 message/modal 实例桥接给非组件代码 */
export function NotifyBridge() {
  const { message, modal } = App.useApp();
  if (!api) {
    api = {
      success: (m) => message.success(m),
      error: (m) => message.error(m),
      info: (m) => message.info(m),
      warning: (m) => message.warning(m),
      confirm: (p) => {
        modal.confirm({ okText: '确认', cancelText: '取消', ...p });
      },
    };
  }
  return null;
}

export const notify: NotifyApi = new Proxy({} as NotifyApi, {
  get(_t, prop: keyof NotifyApi) {
    return (...args: unknown[]) => {
      if (!api) {
        // 极端情况下 bridge 尚未挂载，退化为 console，不阻断操作
        console.warn('[notify before mount]', prop, args);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (api[prop] as any)(...args);
    };
  },
});

/** 便捷确认弹窗（Promise 化） */
export function confirmAsync(props: ModalFuncProps): Promise<boolean> {
  return new Promise((resolve) => {
    notify.confirm({
      ...props,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
