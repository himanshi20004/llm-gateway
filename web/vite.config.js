import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy keeps the browser same-origin, so no CORS is needed locally.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/admin': 'http://localhost:8080', '/v1': 'http://localhost:8080' } },
});
