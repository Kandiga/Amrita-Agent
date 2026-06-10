import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev: the web app talks to a running `amritad --http --port 7460` via a proxy,
// so the browser only ever calls same-origin /rpc and /events.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/rpc': 'http://127.0.0.1:7460',
      // `ws: true` upgrades the `/events/ws` WebSocket through the dev proxy so
      // the browser only ever opens a same-origin socket.
      '/events': { target: 'http://127.0.0.1:7460', ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
