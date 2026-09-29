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
 * The M4-W customer journey, against the real API and a real (disposable) tenant: an
 * Accountant creates a customer, sees its system-generated CUST-… code, edits it, views its
 * (empty) ledger, and the audit trail shows the create. A Viewer sees no create affordance
 * on /customers and is refused on /admin-audit (`audit.view` is Owner-only, catalog.ts's
 * PRIVILEGED_PERMISSIONS — same reasoning as m2-accounting.spec.ts's Viewer-cannot-post
 * check for /vouchers/new).
 *
 * Reuses tests/e2e/helpers/accounting-fixture.ts's tenant/role/user fixture as-is — it is
 * not accounting-specific despite the name (a standard chart + FY2027 + the three MVP
 * system roles + real password hashes), and this lane's own contract forbids inventing a
 * second copy of the same setup.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Same override m2-accounting.spec.ts uses and for the same reason: this file's name does
// not match playwright.config.ts's `web` project glob, so baseURL must be set explicitly or
// every page.goto() below resolves against the API's origin instead of the Next.js app's.
test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 3021)}` })

function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

let fixture: AccountingE2eFixture

test.beforeAll(async () => {
  loadEnvFile()
  await openDatabase()
  fixture = await createAccountingE2eTenant('M4CUST')
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

test.describe('M4-W customer journey (real API, real tenant)', () => {
  test('accountant creates, edits and views a customer; audit shows the create; a Viewer is refused', async ({
    page,
    browser,
  }) => {
    await login(page, fixture.accountantEmail, fixture.password)

    // 1. Create — the wizard's supported subset only; the server assigns the code.
    await page.goto('/customers')
    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible()
    await page.getByRole('button', { name: /New Customer/ }).click()
    await expect(page.getByText('Basic Information')).toBeVisible()

    const customerName = `E2E Customer ${Date.now()}`
    await page.getByPlaceholder('Ahmed Traders').fill(customerName)
    await expect(
      page.locator('input[value="Assigned automatically on save"]'),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: /Create Customer/ }).click()

    // 2. Lands on the real detail page, with the server's own CUST-… code.
    await expect(page).toHaveURL(/\/customers\/.+/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: customerName })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/^CUST-\d{6}$/).first()).toBeVisible()

    // 3. Edit — Quick Edit, a real PATCH with the version this page read.
    const nameInput = page.locator('#quick-edit-name')
    await nameInput.fill(`${customerName} (Updated)`)
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(page.getByRole('button', { name: /saved/i })).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole('heading', { name: `${customerName} (Updated)` }),
    ).toBeVisible()

    // 4. Ledger — real C7, empty (no postings against a brand-new customer). Never a
    // fabricated running balance: the empty state names the range, not "no data".
    await expect(page.getByRole('heading', { name: 'Account Ledger' })).toBeVisible()
    await expect(page.getByText('No entries in this view.')).toBeVisible()

    // 5. Audit trail — the create is there, attributable, newest first.
    await page.goto('/admin-audit')
    await expect(page.getByText('Customer created').first()).toBeVisible({ timeout: 15_000 })

    // 6. A Viewer: no create affordance on /customers, and refused on /admin-audit.
    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    await login(viewerPage, fixture.viewerEmail, fixture.password)

    await viewerPage.goto('/customers')
    await expect(viewerPage.getByRole('heading', { name: 'Customers' })).toBeVisible()
    await expect(viewerPage.getByRole('button', { name: /New Customer/ })).toBeDisabled()

    await viewerPage.goto('/admin-audit')
    await expect(
      viewerPage.getByText(/your role does not have permission to view the audit trail/i),
    ).toBeVisible({ timeout: 15_000 })

    await viewerContext.close()
  })
})
