import { defineConfig, devices } from '@playwright/test'

/*
 * Browser tests against an ALREADY-DEPLOYED origin.
 *
 * Separate from playwright.config.ts, which starts its own API and runs on
 * every pull request. This one starts nothing: it is pointed at a real
 * deployment and runs immediately after it, as part of the deploy job.
 *
 * Kept apart deliberately. Folding these into the PR suite would make every
 * pull request depend on staging being up, so an unrelated change would fail
 * because a server was restarting — and a suite that fails for reasons
 * outside the change gets ignored, then deleted.
 */

const BASE_URL = process.env.E2E_BASE_URL

if (!BASE_URL) {
  throw new Error(
    'E2E_BASE_URL is required — this config tests a deployed origin and starts nothing itself.',
  )
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.deployed.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry: this crosses a real network to a real host, and a single
  // transient failure should not fail a deploy that is otherwise healthy.
  retries: 1,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
