import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const FRONTEND_HOST = '0.0.0.0';
const FRONTEND_PORT = 3000;
const BACKEND_HTTP_URL = 'http://127.0.0.1:3001';
const BACKEND_WS_URL = 'ws://127.0.0.1:3001';

const proxy = {
  '/api': {
    target: BACKEND_HTTP_URL,
    changeOrigin: true
  },
  '/uploads': {
    target: BACKEND_HTTP_URL,
    changeOrigin: true
  },
  '/ws': {
    target: BACKEND_WS_URL,
    ws: true
  }
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: FRONTEND_HOST,
    port: FRONTEND_PORT,
    strictPort: true,
    proxy
  },
  preview: {
    host: FRONTEND_HOST,
    port: FRONTEND_PORT,
    strictPort: true,
    proxy
  }
});
