import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Load .env for local runs. In CI, env vars come from GitHub Actions secrets
// (see .github/workflows/playwright.yml). dotenv is a noop if .env is absent.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '.env') });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://ibscout.netlify.app';

// All storage-state-consuming projects load this file. The setup project
// writes it. See e2e/global.setup.ts.
const AUTH_STATE = 'playwright/.auth/user.json';

export default defineConfig({
  testDir: './tests',
  // Tight per-test timeout while debugging — failing specs die fast so we
  // iterate on CI without burning 5+ minutes per run. Setup overrides this
  // with setup.setTimeout(60_000) to allow its 30s IBAuth.ready wait.
  timeout: 10_000,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html'], ['list']],

  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // retries=0 makes 'on-first-retry' a noop, switch to retain-on-failure
    // so we still get traces from broken runs.
    trace: 'retain-on-failure',
  },

  projects: [
    // Runs once before any other project; authenticates the test user via
    // Auth0 Password Grant and saves storage state to AUTH_STATE.
    {
      name: 'setup',
      testDir: './e2e',
      testMatch: /global\.setup\.ts/,
    },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'], storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
  ],
});
