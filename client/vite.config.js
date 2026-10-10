import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Override with API_URL if the API runs on another port (e.g. PORT=4100).
    proxy: { '/api': process.env.API_URL || 'http://localhost:4000' },
  },
});
