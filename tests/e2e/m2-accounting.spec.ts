import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  createAccountingE2eTenant,
  type AccountingE2eFixture,
} from './helpers/accounting-fixture.ts'

/*
 * The M2 accounting journey, against the real API and a real (disposable) tenant: log in, view
 * the seeded chart of accounts, post a balanced journal voucher (Dr Cash in Hand / Cr Service
 * Revenue... actually Owner's Capital, since coa-standard.md marks Service Revenue as
 * "not used by an event; JV" — still fine for a manual JV, but Owner's Capital is the
 * documented demo-opening-capital line, coa-standard.md §6), see it in the register, the
 * ledger and the cash book, check the trial balance balances, reverse it, check the trial
 * balance is still balanced, and confirm a Viewer cannot post.
 *
 * Same infrastructure pattern as real-login.spec.ts: this file's own process opens the
 * `DATABASE_URL`-pointed pool (not TEST_DATABASE_URL) because playwright.config.ts spawns the
 * API as its own OS process reading the same `.env` — a fixture written into an isolated
 * `_test` cluster from this process would be invisible to it.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/*
 * This file's name does not end in "login.spec.ts", so playwright.config.ts's `web` project
 * (the only one whose `baseURL` points at the Next.js app, `WEB_BASE_URL`) does not claim it —
 * it would otherwise run under the default `chromium` project, whose `baseURL` is the API's
 * own origin (`BASE_URL`), and every `page.goto('/login')` etc. below would 404 against the
 * API instead of reaching the app. Overridden explicitly here rather than renaming this file
 * to fit an unrelated login-specific glob.
 */
test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 3021)}` })

function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

let fixture: AccountingE2eFixture

test.beforeAll(async () => {
  loadEnvFile()
  await openDatabase()
  fixture = await createAccountingE2eTenant('M2E2E')
})

test.afterAll(async () => {
  await closeDatabase()
})

async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/tenant code/i).fill(fixture.code)
  await page.getByLabel(/^email/i).fill(email)
  await page.getByLabel(/^password/i).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
}

test.describe('M2 accounting journey (real API, real tenant)', () => {
  test('accountant views the chart, posts a balanced JV, sees it register/ledger/cash-book/TB, reverses it; a Viewer cannot post', async ({
    page,
    browser,
  }) => {
    await login(page, fixture.accountantEmail, fixture.password)

    // 1. Chart of Accounts — the PO's original screen design, restored (M2-UI). Add/Edit/Move
    // are back in the DOM (the PO now wants account creation in the MVP) but disabled behind
    // ACCOUNT_CREATE_ENABLED until a real POST /api/accounts exists — the chart itself is
    // still read-only server-side (coa-standard.md §5). There is no Delete button at all:
    // accounts are never hard-deleted.
    await page.goto('/accounts')
    await expect(
      page.getByRole('heading', { name: 'Chart of Accounts', exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Cash in Hand')).toBeVisible()
    await expect(page.getByRole('button', { name: /add account/i })).toBeDisabled()

    // 2. Post a balanced journal voucher: Dr Cash in Hand / Cr Owner's Capital.
    await page.goto('/vouchers/new')
    await expect(page.getByLabel('Account line 1')).toBeVisible()
    await page.getByLabel(/^narration/i).fill('E2E: owner capital contribution')
    await page.getByLabel('Account line 1').selectOption({ label: 'Cash in Hand (1110)' })
    await page.getByLabel('Debit line 1').fill('75000')
    await page.getByLabel('Account line 2').selectOption({ label: "Owner's Capital (3100)" })
    await page.getByLabel('Credit line 2').fill('75000')
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible()

    const postButton = page.getByRole('button', { name: /post voucher/i })
    await expect(postButton).toBeEnabled()
    await postButton.click()

    // Confirm-before-post dialog (voucher-new.md): names the date, totals and line count, and
    // requires an explicit second click — opening it must not itself have posted anything.
    const confirmDialog = page.getByRole('dialog', { name: /post voucher/i })
    await expect(confirmDialog.getByText('Rs 75,000.00').first()).toBeVisible()
    await confirmDialog.getByRole('button', { name: /post voucher/i }).click()

    await expect(page).toHaveURL(/\/vouchers\/.+/, { timeout: 15_000 })
    // Next's client-side transition can land the URL a beat before the new route's own tree
    // replaces the previous page's — wait for the heading to actually be the entry number
    // (auto-retrying) rather than reading textContent() once, which can catch a stale frame.
    const heading = page.getByRole('heading', { level: 1 })
    await expect(heading).toHaveText(/^JV-\d{4}-\d{6}$/, { timeout: 15_000 })
    const entryNumber = (await heading.textContent())!.trim()

    // 3. See it in the register.
    await page.goto('/vouchers')
    await expect(page.getByText(entryNumber)).toBeVisible()

    // 4. See it in the account ledger (Cash in Hand is the first postable account, default-selected).
    await page.goto('/ledgers')
    await expect(page.getByText(entryNumber)).toBeVisible({ timeout: 15_000 })

    // 5. See it in the cash book (same account, resolved by role).
    await page.goto('/cash-book')
    await expect(page.getByText(entryNumber)).toBeVisible({ timeout: 15_000 })

    // 6. Trial balance is balanced.
    await page.goto('/trial-balance')
    await expect(page.getByText(/^Balanced/)).toBeVisible({ timeout: 15_000 })

    // 7. Reverse it, with a reason and confirmation.
    await page.goto('/vouchers')
    await page.getByText(entryNumber).click()
    await page.getByRole('button', { name: 'Open voucher' }).click()
    await expect(page).toHaveURL(/\/vouchers\/.+/)
    await page.getByRole('button', { name: 'Reverse' }).click()
    await page.getByLabel(/^reason/i).fill('E2E test cleanup')
    await page.getByLabel(/I understand this cannot be undone/i).check()
    await page.getByRole('button', { name: 'Reverse voucher' }).click()
    await expect(page.getByText('Reversed', { exact: true })).toBeVisible({ timeout: 15_000 })

    // 8. Trial balance is STILL balanced after the reversal.
    await page.goto('/trial-balance')
    await expect(page.getByText(/^Balanced/)).toBeVisible({ timeout: 15_000 })

    // 9. A Viewer cannot post — separate browser context, separate session.
    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    await login(viewerPage, fixture.viewerEmail, fixture.password)
    await viewerPage.goto('/vouchers/new')
    await expect(viewerPage.getByLabel('Account line 1')).toBeVisible()
    await viewerPage.getByLabel(/^narration/i).fill('Should be rejected')
    await viewerPage.getByLabel('Account line 1').selectOption({ label: 'Cash in Hand (1110)' })
    await viewerPage.getByLabel('Debit line 1').fill('1')
    await viewerPage.getByLabel('Account line 2').selectOption({ label: "Owner's Capital (3100)" })
    await viewerPage.getByLabel('Credit line 2').fill('1')
    await viewerPage.getByRole('button', { name: /post voucher/i }).click()
    await viewerPage
      .getByRole('dialog', { name: /post voucher/i })
      .getByRole('button', { name: /post voucher/i })
      .click()
    // No real per-user permission list reaches the client yet (M2-S page docs' shared note) —
    // the server's 403 is the real gate, and apps/web/src/lib/api/client.ts's FIXED, product-
    // wide contract for a 403 from any apiFetch call is a redirect to /unauthorized (not an
    // inline form error) — the voucher was never posted.
    await expect(viewerPage).toHaveURL(/\/unauthorized/, { timeout: 15_000 })
    await expect(viewerPage.getByText('Access restricted')).toBeVisible()
    await viewerContext.close()
  })
})
