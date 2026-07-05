import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev-server API target: local backend by default. Point VITE_API_PROXY (e.g. in
// .env.local, gitignored) at a running env instead — http://192.168.1.250:8767 =
// stage VIP — to preview UI changes against real data without a local backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const api = env.VITE_API_PROXY || 'http://localhost:3000';
  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': api,
        '/receipts': api,
      },
    },
  };
});
