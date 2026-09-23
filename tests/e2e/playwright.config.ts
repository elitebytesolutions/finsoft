import { defineConfig, devices } from '@playwright/test'

/*
 * Browser-to-API journeys.
 *
 * The API is started by Playwright rather than assumed to be running, so the
 * suite is self-contained: a developer runs one command and CI runs the same
 * one. `reuseExistingServer` is on locally so an already-running dev server is
 * used instead of fighting it for the port, and off in CI where a leftover
 * process would mean testing something other than this commit.
 */

const PORT = Number(process.env.E2E_API_PORT ?? 3011)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // A browser test that hangs should fail, not stall the pipeline.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    /*
     * Built, then run from dist — the same artefact shape the container runs.
     * `nest start` would work and would exercise a different code path than
     * production, which is the one thing an end-to-end suite should not do.
     */
    /*
     * --env-file-if-exists, because Playwright does not load .env and the API
     * reads DATABASE_URL from the environment. Without it the process starts
     * happily, liveness answers 200, and readiness returns 503 — which looks
     * like a broken database rather than a missing variable.
     */
    command: `npm run build --workspace @finsoft/api && node --env-file-if-exists=.env apps/api/dist/main.js`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '../..',
    env: { API_PORT: String(PORT), NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
