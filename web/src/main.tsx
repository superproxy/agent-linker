import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './App';
import { themeConfig } from './theme';
import { NotifyBridge } from './lib/notify';
import { RefreshProvider } from './lib/hooks';
import 'antd/dist/reset.css';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ConfigProvider theme={themeConfig} locale={zhCN}>
      <AntdApp>
        <NotifyBridge />
        <RefreshProvider>
          <App />
        </RefreshProvider>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);
