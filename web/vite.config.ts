import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后台管理 UI 只产出静态文件，由网关（8787）挂载到 /：
//   - 独立部署产物：<installRoot>/web
//   - 开发模式：仓库 web/dist（vite build --watch 自动重建，刷新 / 即可）
// 不再单独起 vite dev server（无 5173 端口）。
// base 用相对路径，保证资源在任意挂载前缀下正确加载。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
});
