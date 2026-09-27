import { defineConfig, devices } from '@playwright/test'

/*
 * Browser-to-API journeys, plus (M1-W) browser-to-web-app journeys for pages
 * that have no real API to call yet.
 *
 * The API is started by Playwright rather than assumed to be running, so the
 * suite is self-contained: a developer runs one command and CI runs the same
 * one. `reuseExistingServer` is on locally so an already-running dev server is
 * used instead of fighting it for the port, and off in CI where a leftover
 * process would mean testing something other than this commit.
 */

const PORT = Number(process.env.E2E_API_PORT ?? 3011)
const BASE_URL = `http://127.0.0.1:${PORT}`

/*
 * The web app's own server, for login.spec.ts. That spec drives the rendered
 * Next.js /login page and intercepts /api/auth/* with `page.route` — there is
 * no real auth API to call yet (m1-auth's lane), so this app is started on its
 * own, without the API webServer entry below, and login.spec.ts never expects
 * a request to leave the mocked routes. `next dev` rather than a production
 * build: this spec exercises page behaviour against a mocked network layer,
 * not the build artefact — that is already covered by the `web-preview` CI job
 * and the `images` job's `web` build.
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3021)
const WEB_BASE_URL = `http://127.0.0.1:${WEB_PORT}`

export default defineConfig({
  testDir: '.',
  /*
   * Excludes *.deployed.spec.ts, which run against a real deployment and are
   * driven by playwright.deployed.config.ts after the deploy step. Matching
   * them here would make every pull request depend on staging being up.
   */
  testMatch: /(?<!\.deployed)\.spec\.ts$/,
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

  projects: [
    // Every existing (API) journey. login.spec.ts is excluded here — it runs
    // against the web app's own origin, not the API's, in the project below.
    {
      name: 'chromium',
      testIgnore: /login\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'web',
      testMatch: /login\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: WEB_BASE_URL },
    },
  ],

  webServer: [
    {
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
    {
      // `npx` resolves the workspace-local `next` binary from apps/web's own
      // node_modules — no need to hoist or depend on the root shelling out to
      // the right nested binary. `--port` overrides apps/web/package.json's
      // hardcoded `next dev --port 3000`, which would otherwise collide with
      // a developer's own local dev server.
      command: `npx next dev --port ${WEB_PORT}`,
      url: `${WEB_BASE_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../../apps/web',
      env: { NEXT_TELEMETRY_DISABLED: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
