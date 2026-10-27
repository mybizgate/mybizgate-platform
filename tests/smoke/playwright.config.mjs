// Generic smoke tests for a built MyBizGate site. Serves SMOKE_DIST (default ../../../dist)
// with a static server, or targets SMOKE_URL when set.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const dist = path.resolve(process.env.SMOKE_DIST || path.join(process.cwd(), 'dist'));
const port = Number(process.env.SMOKE_PORT || 4173);
const baseURL = process.env.SMOKE_URL || `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: '.',
  testMatch: /smoke\.spec\.mjs/,
  timeout: 60000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, ignoreHTTPSErrors: false },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.SMOKE_URL ? undefined : {
    command: `node serve-static.mjs "${dist}" ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
