import { defineConfig } from '@playwright/test'

// python with the server requirements installed, CI uses the system one
const python = process.env.PYTHON || '.venv/bin/python'

// End-to-end tests: starts the real server (same gunicorn setup as the
// Dockerfile) and a production build of the client, then plays games in Chrome.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${python} -m gunicorn --worker-class gthread --workers 1 --threads 100 `
        + '--bind 127.0.0.1:8000 --no-control-socket game:app',
      cwd: '../server',
      url: 'http://127.0.0.1:8000/healthz',
      env: { CORS_ORIGINS: 'http://localhost:4173', COUNTDOWN_SECONDS: '1' },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4173 --strictPort',
      url: 'http://localhost:4173',
      env: { VITE_SOCKET_SERVER: 'http://localhost:8000' },
      reuseExistingServer: !process.env.CI,
    },
  ],
})
