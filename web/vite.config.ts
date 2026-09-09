import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后台管理 UI。开发时直接请求绝对网关地址（网关已开 CORS origin:true），
// 无需代理；如需同源部署，可在此加 /v1、/healthz 代理。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
});
