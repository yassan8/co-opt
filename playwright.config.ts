import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.COOPT_E2E_BASE_URL?.trim();
const baseURL = externalBaseUrl
  ? `${externalBaseUrl.replace(/\/+$/, '')}/`
  : 'http://127.0.0.1:4178/co-opt/';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  outputDir: 'diagnostics/playwright-results',
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'edge',
      use: { browserName: 'chromium', channel: 'msedge' },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4178',
        url: 'http://127.0.0.1:4178/co-opt/',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
