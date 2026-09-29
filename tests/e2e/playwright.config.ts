import { defineConfig, devices } from '@playwright/test'

/*
 * Browser-to-API journeys, plus (M1-W) browser-to-web-app journeys — some
 * against a mocked `/api/auth/*` (login.spec.ts, the screen's own behaviour
 * in isolation), and since M1-A landed the real auth API, one against the
 * genuine thing end to end (real-login.spec.ts).
 *
 * Both the API and the web app are started by Playwright rather than assumed
 * to be running, so the suite is self-contained: a developer runs one command
 * and CI runs the same one. `reuseExistingServer` is on locally so an
 * already-running dev server is used instead of fighting it for the port, and
 * off in CI where a leftover process would mean testing something other than
 * this commit.
 */

const PORT = Number(process.env.E2E_API_PORT ?? 3011)
const BASE_URL = `http://127.0.0.1:${PORT}`

/*
 * The web app's own server, for the `web` project (login.spec.ts and
 * real-login.spec.ts). `login.spec.ts` drives the rendered Next.js /login page
 * and intercepts /api/auth/* with `page.route`, proving the screen's own
 * behaviour independent of any backend. `real-login.spec.ts` (M1-A having
 * landed the real auth API) makes no such interception and goes through
 * apps/web/next.config.mjs's dev-only `/api/:path*` rewrite to the API
 * webServer above instead — same arrangement Caddy gives production, one
 * origin for both. That rewrite reads `API_PORT` at process start, so it is
 * set here to the SAME port the API webServer entry binds to (`PORT`,
 * `E2E_API_PORT` below) — left unset, it would default to 3001 and every real
 * request would 404 against nothing listening there. `next dev` rather than a
 * production build: these specs exercise page behaviour against Next's dev
 * server, not the build artefact — that is already covered by the
 * `web-preview` CI job and the `images` job's `web` build.
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
      // API_PORT: matches the API webServer entry above, so the dev-only
      // rewrite in next.config.mjs proxies /api/* to the real, running API
      // instead of its 3001 default (nothing listens there in this suite).
      env: { NEXT_TELEMETRY_DISABLED: '1', API_PORT: String(PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
