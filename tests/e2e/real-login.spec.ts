import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  createActiveUserFixture,
  type ActiveUserFixture,
} from '../integration/helpers/auth-seed.ts'

/*
 * The login journey against the REAL auth API (apps/api/src/auth/*), now that
 * M1-A has landed it on develop — login.spec.ts (same `web` Playwright
 * project, playwright.config.ts) keeps the page.route-mocked coverage for the
 * error states the fixed contract promises (401, 429, network failure); this
 * file is the one place that promise is checked against a genuine database,
 * a genuine argon2id hash and a genuine HttpOnly refresh cookie.
 *
 * ── Why this seeds through DATABASE_URL, not TEST_DATABASE_URL ───────────
 *
 * `packages/database/src/testing/harness.ts`'s `prepareTestDatabase()` is the
 * pattern every other DB-backed suite in this repo uses (tests/integration,
 * tests/security, database/tests) — but every one of those runs its Nest
 * application IN-PROCESS (`Test.createTestingModule` + supertest), sharing
 * this file's own module-level database pool by construction (ADR-0013: one
 * pool per process). `prepareTestDatabase()` repoints that shared pool at the
 * disposable `_test` cluster, and the in-process app inherits the repoint for
 * free.
 *
 * This suite is different: `playwright.config.ts` spawns the API as its own
 * OS process (`node apps/api/dist/main.js`), loading `.env`'s `DATABASE_URL`
 * — the ordinary development database, never `TEST_DATABASE_URL`. A fixture
 * written into the isolated `_test` cluster from THIS process would be
 * invisible to that one; the browser would submit real credentials against a
 * server that has never heard of them. So this file opens the same
 * `DATABASE_URL`-pointed pool the spawned API itself opens, and writes there.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

let fixture: ActiveUserFixture

test.beforeAll(async () => {
  loadEnvFile()
  await openDatabase()
  fixture = await createActiveUserFixture('E2E')
})

test.afterAll(async () => {
  await closeDatabase()
})

test.describe('login against the real API', () => {
  test('signs in, restores the session on reload, and signs out', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/tenant code/i).fill(fixture.code)
    await page.getByLabel(/^email/i).fill(fixture.email)
    await page.getByLabel(/^password/i).fill(fixture.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    // 200 from the real POST /api/auth/login, a real access token held in
    // memory, GET /api/auth/me confirming it, and the shell rendering the
    // genuine identity — not a mock's. `.first()`: the tenant name and full
    // name each render twice in the shell (sidebar footer + topbar/company
    // picker — apps/web/src/components/shell.tsx), which is real duplication
    // in the shipped markup, not a flaw in this assertion.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByText(`Fixture ${fixture.code}`).first()).toBeVisible()
    await expect(page.getByText(`Owner of ${fixture.code}`).first()).toBeVisible()

    // A hard reload drops the in-memory access token by construction
    // (apps/web/src/lib/api/session.ts) — the only thing that can restore the
    // session is the silent refresh, driven by the real HttpOnly cookie the
    // login response above actually set in this browser context.
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.getByText(`Fixture ${fixture.code}`).first()).toBeVisible()
    await expect(page.getByText(`Owner of ${fixture.code}`).first()).toBeVisible()

    // Sign-out calls the real POST /api/auth/logout (bearer-authenticated —
    // apps/web/src/lib/api/client.ts) and clears the refresh cookie
    // server-side; the client always lands on /login regardless.
    await page.getByRole('button', { name: /sign out/i }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

    // The cookie is genuinely gone, not just the in-memory token: reloading
    // /login with no route mocks must not silently bounce back to /dashboard.
    await page.reload()
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
  })

  test('the real API rejects a wrong password with a generic 401, never which field', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByLabel(/tenant code/i).fill(fixture.code)
    await page.getByLabel(/^email/i).fill(fixture.email)
    await page.getByLabel(/^password/i).fill('definitely-not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // apps/web/src/lib/api/client.ts renders the server's own `message` for
    // `invalid_credentials` (CLAUDE.md: "the server's rejection is the
    // truth; render it") — which is the real API's literal copy
    // (apps/api/src/auth/auth.controller.ts's INVALID_CREDENTIALS constant,
    // "Invalid tenant, email or password."), NOT the page document's
    // illustrative "Incorrect tenant code, email or password." (see this
    // task's DECISIONS: the two strings have drifted, both equally generic,
    // neither names a field — worth reconciling with the design-system/PO
    // owner, not this lane's call).
    await expect(page.getByRole('status')).toHaveText('Invalid tenant, email or password.')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})
