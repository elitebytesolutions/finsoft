import { expect, test } from '@playwright/test'

/*
 * The M2 accounting journey: log in, post a balanced journal voucher, see it
 * in the register and the ledger, check the trial balance, reverse it, check
 * the trial balance is still balanced, and confirm a Viewer cannot post.
 *
 * SKIPPED — not runnable yet, and this file says exactly why rather than
 * pretending to pass. Two independent blockers, per the M2-S delivery
 * report:
 *
 *   1. The M2-S screens (Chart of Accounts, New Voucher, Voucher detail,
 *      Voucher register, Account ledger, Trial Balance, Period close) are
 *      NOT wired to the real API yet — they still render `apps/web/src/mocks/*`
 *      and carry the prototype banner. Only the API CLIENT layer
 *      (`apps/web/src/lib/api/accounting-client.ts`) is built and unit-tested
 *      against `docs/design/M2/api-contract.md`. A Playwright journey against
 *      the actual screens would be testing DOM that doesn't do what this file
 *      would claim it does.
 *   2. Even once wired, "add an account" is not achievable: `coa-standard.md`
 *      §5 ships the chart read-only in M2, and `docs/design/M2/api-contract.md`
 *      §5 confirms `POST /api/accounts` is not built (no permission code, no
 *      kernel export). That step of the brief's own journey is replaced below
 *      with "open the seeded chart" — there is nothing to add.
 *
 * This spec is written against the ROUTES AND BEHAVIOUR the page docs commit
 * to (docs/design-system/pages/{chart-of-accounts,voucher-new,voucher-detail,
 * voucher-register,account-ledger,trial-balance}/README.md) and the wire
 * shapes in the M2-B contract, so it is ready to un-skip — and to have its
 * selectors corrected against the real rendered DOM, which this agent has not
 * seen — the moment a screens lane finishes wiring. Do not un-skip this file
 * without first running it and fixing selectors against the real app; treat
 * the selectors below as intent, not as verified fact.
 *
 * Seeding: intended to reuse `tests/e2e/real-login.spec.ts`'s pattern
 * (`createActiveUserFixture` against `DATABASE_URL`, since `playwright.config.ts`
 * spawns the API as its own process) plus a Viewer-role fixture from the same
 * tenant, per `packages/permissions/src/system-roles.ts`'s three seeded
 * system roles (Owner/Accountant/Viewer) and `tools/seed/demo-tenants.mjs`'s
 * per-role demo users. Not implemented here — it depends on the screens lane
 * existing to seed against.
 */

test.describe.skip('M2 accounting journey (pending: screens not wired to the real API)', () => {
  test('accountant posts a balanced JV, sees it register/ledger/TB, reverses it; a Viewer cannot post', async ({
    page,
    browser,
  }) => {
    // 1. Log in as an Accountant (real credentials, real session — see
    //    real-login.spec.ts for the seeding pattern this should reuse).
    await page.goto('/login')
    await page.getByLabel('Tenant code').fill('E2ETEST')
    await page.getByLabel('Email').fill('accountant@e2etest.demo')
    await page.getByLabel('Password').fill('placeholder')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/dashboard/)

    // 2. Open the Chart of Accounts — view only in M2 (coa-standard.md §5).
    //    "Add an account" is not attempted: there is no endpoint.
    await page.goto('/accounts')
    await expect(page.getByRole('heading', { name: 'Chart of Accounts' })).toBeVisible()
    const bankRow = page.getByRole('row', { name: /Bank.*Current Account/i })
    await expect(bankRow).toBeVisible()

    // 3. Post a balanced two-line journal voucher.
    await page.goto('/vouchers/new')
    await page.getByLabel('Voucher date').fill('2026-09-27')
    await page.getByLabel('Narration').fill('E2E: owner capital contribution')
    // Line 1: Dr Bank — Current Account
    await page.getByLabel(/Account line 1/i).click()
    await page.getByRole('option', { name: /Bank.*Current Account/i }).click()
    await page.getByLabel(/Debit line 1/i).fill('10000.0000')
    // Line 2: Cr Owner's Capital
    await page.getByLabel(/Account line 2/i).click()
    await page.getByRole('option', { name: "Owner's Capital" }).click()
    await page.getByLabel(/Credit line 2/i).fill('10000.0000')

    await expect(page.getByText('Balanced')).toBeVisible()
    const postButton = page.getByRole('button', { name: /^Post voucher$/i })
    await expect(postButton).toBeEnabled()
    await postButton.click()
    await page.getByRole('button', { name: /confirm/i }).click()

    await expect(page).toHaveURL(/\/vouchers\/.+/)
    const voucherNumber = await page.getByRole('heading', { level: 1 }).textContent()
    expect(voucherNumber).toMatch(/^JV-\d{4}-\d{6}$/)

    // 4. See it in the register.
    await page.goto('/vouchers')
    await expect(page.getByText(voucherNumber!)).toBeVisible()

    // 5. See it in the account ledger, with a running balance.
    await page.goto('/ledgers')
    await page.getByLabel('Switch account').selectOption({ label: 'Bank — Current Account' })
    await expect(page.getByText(voucherNumber!)).toBeVisible()

    // 6. Trial balance is balanced.
    await page.goto('/trial-balance')
    await expect(page.getByText(/^Balanced$/i)).toBeVisible()

    // 7. Reverse the voucher, with a reason and confirmation.
    await page.goto(`/vouchers/${voucherNumber}`) // placeholder — real nav uses the entry id, not the number
    await page.getByRole('button', { name: /^Reverse$/i }).click()
    await page.getByLabel('Reason').fill('E2E test cleanup — reversing the demo posting')
    await page.getByRole('button', { name: /confirm/i }).click()
    await expect(page.getByText(/^Reversed$/i)).toBeVisible()
    const reversalLink = page.getByRole('link', { name: /^RV-\d{4}-\d{6}$/ })
    await expect(reversalLink).toBeVisible()

    // 8. Trial balance is STILL balanced after the reversal.
    await page.goto('/trial-balance')
    await expect(page.getByText(/^Balanced$/i)).toBeVisible()

    // 9. A Viewer cannot post — separate browser context, separate session.
    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    await viewerPage.goto('/login')
    await viewerPage.getByLabel('Tenant code').fill('E2ETEST')
    await viewerPage.getByLabel('Email').fill('viewer@e2etest.demo')
    await viewerPage.getByLabel('Password').fill('placeholder')
    await viewerPage.getByRole('button', { name: /sign in/i }).click()
    await viewerPage.goto('/vouchers/new')
    // No real per-user permission list reaches the client yet (see the
    // M2-S page docs' shared note) — the server's 403 is the actual gate,
    // surfacing here as the fixed 403 -> /unauthorized redirect.
    await expect(viewerPage).toHaveURL(/\/unauthorized/)
    await viewerContext.close()
  })
})
