import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { closeDatabase, openDatabase } from '@finsoft/database'
import {
  createAccountingE2eTenant,
  type AccountingE2eFixture,
} from './helpers/accounting-fixture.ts'
import {
  apiBaseUrl,
  apiCall,
  apiLogin,
  newIdempotencyKey,
  type ApiSession,
} from './helpers/api-client.ts'
import { rs, twoDp } from './helpers/money.ts'

/*
 * M4-E — the MVP journey test (docs/IMPLEMENTATION.md §13, plan Part C "M4"). M4's acceptance
 * gate: log in, create a customer, post a 10,000 service invoice, receive 6,000 against it,
 * watch the customer ledger and trial balance follow the money, reverse the receipt then the
 * invoice (PO-Q1), watch both come back to zero, and prove the audit trail recorded every step
 * while the other tenant saw none of it. Run once per tenant (both, per this lane's brief).
 *
 * ── Why some of this calls the API directly instead of driving a page ─────────────────────────
 *
 * This lane (M4-E) runs alongside two others that have not landed on `develop` yet:
 * feature/M3-P-receivables (the invoice/receipt API — modules/receivables/, uncommitted as of
 * this writing) and feature/M4-W-journey-screens (the screens themselves — no commits at all as
 * of this writing). `/customers` and `/admin-audit` exist today only as `ui-prototype` mocks
 * (docs/design/M3/ui-plan.md §5: "No mock data on an API-backed screen" is the rule M4-W is
 * FOR — until it lands, those routes are exactly the mock data that rule forbids trusting).
 * Driving them with a `page` would prove nothing about the real system. So step 2 (create a
 * customer) and the always-on half of step 9 (audit) go straight at the real, running API
 * (tests/e2e/helpers/api-client.ts) — genuine HTTP, genuine database, no mock — and steps 1 and
 * 6 use the real UI, because M1-A (login) and M2-S (trial balance) are already merged and
 * already real.
 *
 * ── The switch ──────────────────────────────────────────────────────────────────────────────
 *
 * Steps 3-5 and 7-8 (post the invoice, receive the receipt, check the ledger/TB, reverse both,
 * check the ledger/TB again) are written in full below, against docs/design/M3/ui-plan.md §3
 * and §6 and the posting rules (service-sale.md, customer-receipt.md, reversal.md) — but they
 * need both feature branches above merged to actually run. Flip this one line, or set
 * E2E_RECEIVABLES_JOURNEY=1, once they are:
 */
const RECEIVABLES_JOURNEY_READY = process.env.E2E_RECEIVABLES_JOURNEY === '1'

/*
 * Selector note for whoever flips the switch: the sales-voucher and payments-centre selectors
 * below (getByLabel(/description.*line 1/i) etc.) follow the ONE precedent this repo has for a
 * repeating money-grid — m2-accounting.spec.ts's journal voucher ("Account line 1", "Debit line
 * 1") — because feature/M4-W-journey-screens has no commits yet to read real accessible names
 * from (checked at the time this file was written: `git log feature/M4-W-journey-screens` is
 * identical to `develop`). The one genuinely unknown control is the Cash/Bank segmented switch
 * on the receipt form — packages/ui has no `SegmentedControl` export on `develop` yet either —
 * so that one selector tries two plausible role shapes with `.or()` rather than guessing a
 * single one. Whoever lands M4-W should expect to adjust these, and that adjustment is exactly
 * what re-running this file with the switch on will surface.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Same reasoning as m2-accounting.spec.ts: this file's name does not end in "login.spec.ts", so
// playwright.config.ts's `web` project does not claim it, and every page.goto() below would
// otherwise resolve against the API's own origin instead of the Next.js app's.
test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 3021)}` })

function loadEnvFile(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
}

let tenantA: AccountingE2eFixture
let tenantB: AccountingE2eFixture

test.beforeAll(async () => {
  loadEnvFile()
  await openDatabase()
  // Two disposable tenants, per this lane's brief ("both tenants"). Not BHATTI1/BHATTI2 — those
  // are the staging demo tenants mvp-journey.deployed.spec.ts runs against; these are throwaway,
  // created fresh for this run, and never touched again.
  tenantA = await createAccountingE2eTenant('M4EA')
  tenantB = await createAccountingE2eTenant('M4EB')
})

test.afterAll(async () => {
  await closeDatabase()
})

/**
 * Signs in through the real screen and returns the SAME access token the app itself now holds
 * in memory, by reading it off the real `POST /api/auth/login` response as the browser receives
 * it. Deliberately not a second, independent `apiLogin()` call: `users.version` (auth's
 * "permission version", packages/database/src/auth/login.ts) is bumped by login itself, so a
 * token minted by an earlier, separate login for the same user goes stale — measured directly:
 * an `apiLogin()` before this UI login left the API-obtained token rejected
 * (`PermissionVersionStaleError` -> 401) the moment this second, real login committed. One
 * login, one token, used for both the browser and this file's direct API calls — which also
 * means step 9/10's direct calls are proven to run under the exact token the screens in steps
 * 3-5/7-8 would also be using.
 */
async function login(page: Page, code: string, email: string, password: string): Promise<string> {
  await page.goto('/login')
  await page.getByLabel(/tenant code/i).fill(code)
  await page.getByLabel(/^email/i).fill(email)
  await page.getByLabel(/^password/i).fill(password)
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  const body = (await response.json()) as { accessToken: string }
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
  return body.accessToken
}

interface JourneyState {
  customerId: string
  customerCode: string
  customerName: string
  invoiceId: string
  invoiceNumber: string
  receiptId: string
  receiptNumber: string
}

async function runJourney(
  page: Page,
  request: APIRequestContext,
  browser: Browser,
  mine: AccountingE2eFixture,
  other: AccountingE2eFixture,
): Promise<void> {
  const baseUrl = apiBaseUrl()
  const state: Partial<JourneyState> = {}
  let mySession!: ApiSession

  // ── 1. log in ──────────────────────────────────────────────────────────────────────────────
  await test.step('1. log in', async () => {
    const accessToken = await login(page, mine.code, mine.accountantEmail, mine.password)
    mySession = { baseUrl, tenantCode: mine.code, accessToken }
  })

  // ── 2. create a customer ──────────────────────────────────────────────────────────────────
  await test.step('2. create a customer', async () => {
    const customerName = `MVP Journey Customer ${mine.code}`
    const createBody = {
      name: customerName,
      phone: null,
      email: null,
      address: null,
      city: null,
      ntn: null,
      creditDays: 30,
    }
    const key = newIdempotencyKey()

    const created = await apiCall<{
      id: string
      code: string
      name: string
      balance: string
      status: string
    }>(request, mySession, 'POST', '/api/customers', { data: createBody, idempotencyKey: key })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.code).toMatch(/^CUST-\d{6}$/)
    expect(created.body.balance).toBe('0.0000') // no posting yet — a fresh AR sub-ledger, per coa-standard.md
    expect(created.body.status).toBe('ACTIVE')

    // Idempotency (NON_NEGOTIABLES rule 14, api-contract.md §1): the identical request, same
    // key, must return the SAME customer, not a second one.
    const replay = await apiCall<{ id: string }>(request, mySession, 'POST', '/api/customers', {
      data: createBody,
      idempotencyKey: key,
    })
    expect(replay.body.id).toBe(created.body.id)

    const list = await apiCall<{ items: Array<{ id: string; code: string }> }>(
      request,
      mySession,
      'GET',
      '/api/customers',
      { query: { q: created.body.code } },
    )
    expect(list.body.items.filter((c) => c.id === created.body.id)).toHaveLength(1)

    state.customerId = created.body.id
    state.customerCode = created.body.code
    state.customerName = customerName
  })

  const { customerId, customerCode, customerName } = state as JourneyState
  void customerCode

  // ── 3-5: the invoice and receipt legs, gated ──────────────────────────────────────────────
  if (RECEIVABLES_JOURNEY_READY) {
    await test.step('3. post a service invoice for 10,000', async () => {
      await page.goto(`/sales/voucher?customer=${customerId}`)
      // Customer pre-selected from the query param (ui-plan.md §3, sales-voucher).
      await expect(page.getByText(customerName)).toBeVisible()

      await page.getByLabel(/^narration/i).fill('E2E: MVP journey service invoice')

      /*
       * service-sale.md §3's own worked payload, used deliberately rather than a single round
       * line: line 1 (1 x 7,500.000000) rounds with nothing to prove; line 2 (3 x 833.333333 =
       * 2,499.999999) is the case where every digit past the 4th decimal is a 9, so half-up
       * rounding cascades the carry all the way to 2,500.0000 — the "rounding residual would
       * otherwise disappear" case, not a coincidence (P10 exists for exactly this).
       */
      await page.getByLabel(/description.*line 1/i).fill('Monthly maintenance')
      await page.getByLabel(/qty.*line 1/i).fill('1')
      await page.getByLabel(/rate.*line 1/i).fill('7500')
      await expect(page.getByText(twoDp('7500'))).toBeVisible({ timeout: 10_000 })

      await page.getByRole('button', { name: /add row/i }).click()
      await page.getByLabel(/description.*line 2/i).fill('Site visit')
      await page.getByLabel(/qty.*line 2/i).fill('3')
      await page.getByLabel(/rate.*line 2/i).fill('833.333333')
      await expect(page.getByText(twoDp('2500'))).toBeVisible({ timeout: 10_000 })

      // TotalsBar's Net amount — server-computed (I6), never summed by the browser
      // (ui-plan.md §1 rule 2).
      await expect(page.getByText(twoDp('10000'))).toBeVisible()

      const postButton = page.getByRole('button', { name: /save\s*&\s*post/i })
      await expect(postButton).toBeEnabled()
      await postButton.click()

      // Confirm dialog quotes the server's own figures verbatim (ui-plan.md §3).
      const confirmDialog = page.getByRole('dialog', { name: /save\s*&\s*post|post invoice/i })
      await expect(confirmDialog.getByText(rs('10000')).first()).toBeVisible()
      await expect(confirmDialog.getByText(customerName)).toBeVisible()
      await confirmDialog.getByRole('button', { name: /save\s*&\s*post|post invoice/i }).click()

      await expect(page).toHaveURL(/\/sales\/.+/, { timeout: 15_000 })
      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 15_000 })
      state.invoiceNumber = (await heading.textContent())!.trim()
      state.invoiceId = new URL(page.url()).pathname.split('/').pop()!

      await expect(page.getByText('Posted', { exact: true })).toBeVisible()
      await expect(page.getByText(/^open$/i)).toBeVisible() // settlement, beside Posted
    })

    await test.step('4. receive 6,000 against it', async () => {
      const { invoiceId, invoiceNumber } = state as JourneyState
      await page.goto(`/payments?customer=${customerId}&invoice=${invoiceId}`)

      await page.getByLabel(/amount received/i).fill('6000')

      const bankOption = page
        .getByRole('radio', { name: 'Bank', exact: true })
        .or(page.getByRole('button', { name: 'Bank', exact: true }))
      await bankOption.click()

      await page.getByRole('button', { name: /auto-allocate/i }).click()
      const invoiceRow = page.getByRole('row', { name: new RegExp(invoiceNumber) })
      await expect(invoiceRow).toContainText(twoDp('6000'))

      /*
       * PO-Q1 / the receipt-drafts ruling (customer-receipt.md §1.1, Product Owner
       * 2026-09-28): save as a DRAFT first. A draft has NO accounting effect — the invoice
       * must still show fully outstanding until this is actually posted (ui-plan.md §6 step 4
       * makes this assertion explicitly, and it is the reason this step does not just post
       * directly).
       */
      await page.getByRole('button', { name: /save draft/i }).click()
      await expect(page.getByText(/draft/i)).toBeVisible({ timeout: 15_000 })

      await page.goto(`/sales/${invoiceId}`)
      await expect(page.getByText(twoDp('10000'))).toBeVisible()
      await expect(page.getByText(/^open$/i)).toBeVisible()

      // Reopen the draft from the register (ui-plan.md §6 step 4) and post it for real.
      await page.goto('/payments')
      await page.getByText(/draft/i).first().click()
      await page.getByRole('button', { name: /^open$/i }).click()
      await expect(page).toHaveURL(/\/payments\/.+/, { timeout: 15_000 })
      state.receiptId = new URL(page.url()).pathname.split('/').pop()!

      const postButton = page.getByRole('button', { name: /^post$/i })
      await expect(postButton).toBeEnabled()
      await postButton.click()

      const confirmDialog = page.getByRole('dialog', { name: /post/i })
      await expect(confirmDialog.getByText(rs('6000')).first()).toBeVisible()
      await confirmDialog.getByRole('button', { name: /^post$/i }).click()

      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toHaveText(/^RCT-\d{4}-\d{6}$/, { timeout: 15_000 })
      state.receiptNumber = (await heading.textContent())!.trim()

      await expect(page.getByText('Posted', { exact: true })).toBeVisible()
    })

    await test.step('5. the customer ledger shows 4,000', async () => {
      const { invoiceId, receiptNumber, invoiceNumber } = state as JourneyState
      await page.goto(`/sales/${invoiceId}`)
      await expect(page.getByText(/partially paid/i)).toBeVisible()
      await expect(page.getByText(twoDp('4000'))).toBeVisible() // outstanding
      await expect(page.getByText(new RegExp(receiptNumber))).toBeVisible() // PaymentPanel

      await page.goto(`/customers/${customerId}`)
      await expect(page.getByText(twoDp('4000'))).toBeVisible() // KpiRow Outstanding
      await page.getByRole('tab', { name: 'Ledger' }).click()
      await expect(page.getByText(invoiceNumber)).toBeVisible()
      await expect(page.getByText(receiptNumber)).toBeVisible()
      await expect(page.getByText(twoDp('4000'))).toBeVisible() // closing balance

      // Belt-and-braces: the authoritative figure straight from C7/K5, not only what the
      // screen renders.
      const ledger = await apiCall<{ closingBalance: string }>(
        request,
        mySession,
        'GET',
        `/api/customers/${customerId}/ledger`,
      )
      expect(ledger.body.closingBalance).toBe('4000.0000')
    })
  } else {
    test.info().annotations.push({
      type: 'gated',
      description:
        'Steps 3-5 (invoice + receipt) did not run: set E2E_RECEIVABLES_JOURNEY=1 once ' +
        'feature/M3-P-receivables and feature/M4-W-journey-screens are merged to develop.',
    })
  }

  // ── 6. the trial balance balances ─────────────────────────────────────────────────────────
  await test.step('6. the trial balance balances', async () => {
    await page.goto('/trial-balance')
    if (RECEIVABLES_JOURNEY_READY) {
      await expect(page.getByText(/^Balanced/)).toBeVisible({ timeout: 15_000 })
      // 1200 Accounts Receivable — Trade Debtors, per service-sale.md §5 / coa-standard.md.
      const arRow = page.getByRole('row', { name: /1200/ })
      await expect(arRow).toContainText(twoDp('4000'))
    } else {
      // Steps 3-5 are gated off, so this tenant genuinely has zero postings yet — the screen's
      // own empty state ("Every account with activity..."), not "Balanced", which appears only
      // once an account has activity. Trivial (0 = 0) is still a real state this screen must
      // render correctly, and this is the only point in the always-on journey that visits it.
      await expect(page.getByRole('status')).toContainText(/no activity/i, { timeout: 15_000 })
    }
  })

  // ── 7-8: reversal, gated ──────────────────────────────────────────────────────────────────
  if (RECEIVABLES_JOURNEY_READY) {
    await test.step('7. reverse the receipt, then the invoice (PO-Q1)', async () => {
      const { invoiceId, receiptId, receiptNumber } = state as JourneyState

      // PO-Q1 Option A (service-sale.md §8, Product Owner 2026-09-27): a part-paid invoice
      // cannot be reversed while a receipt still holds a LIVE allocation against it. Assert the
      // block is real BEFORE doing anything about it.
      await page.goto(`/sales/${invoiceId}`)
      const reverseInvoiceButton = page.getByRole('button', { name: 'Reverse', exact: true })
      await expect(reverseInvoiceButton).toBeDisabled()
      await expect(page.getByText(new RegExp(receiptNumber))).toBeVisible()

      // Reverse the receipt first.
      await page.goto(`/payments/${receiptId}`)
      await page.getByRole('button', { name: 'Reverse', exact: true }).click()
      await page.getByLabel(/^reason/i).fill('E2E test cleanup: receipt reversal')
      await page.getByLabel(/I understand this cannot be undone/i).check()
      await page.getByRole('button', { name: /reverse receipt/i }).click()
      await expect(page.getByText('Reversed', { exact: true })).toBeVisible({ timeout: 15_000 })

      // The allocation is VOIDED, never deleted (customer-receipt.md §7) — the invoice is open
      // again, for the full original amount.
      await page.goto(`/sales/${invoiceId}`)
      await expect(page.getByText(twoDp('10000'))).toBeVisible()
      await expect(page.getByText(/^open$/i)).toBeVisible()

      // Now the invoice itself can be reversed.
      await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'Reverse', exact: true }).click()
      await page.getByLabel(/^reason/i).fill('E2E test cleanup: invoice reversal')
      await page.getByLabel(/I understand this cannot be undone/i).check()
      await page.getByRole('button', { name: /reverse invoice/i }).click()
      await expect(page.getByText('Reversed', { exact: true })).toBeVisible({ timeout: 15_000 })
    })

    await test.step('8. the ledger and TB are correct again', async () => {
      await page.goto(`/customers/${customerId}`)
      await page.getByRole('tab', { name: 'Ledger' }).click()
      // Zero renders as an em dash in ledger columns (design-system/04-states.md convention) —
      // asserted authoritatively through the API instead of guessing the glyph.
      const ledger = await apiCall<{ closingBalance: string }>(
        request,
        mySession,
        'GET',
        `/api/customers/${customerId}/ledger`,
      )
      expect(ledger.body.closingBalance).toBe('0.0000')

      await page.goto('/trial-balance')
      await expect(page.getByText(/^Balanced/)).toBeVisible({ timeout: 15_000 })
      // The reversed pair nets to zero, not "vanishes" — both entries stay on the books
      // (NON_NEGOTIABLES rule 2/4). No further UI assertion here: which account rows a
      // zero-balance account still renders on is a screen decision this lane does not own.
    })
  }

  // ── 9. the audit trail shows every step ───────────────────────────────────────────────────
  await test.step('9. the audit trail shows every step', async () => {
    const customerEvents = await apiCall<{
      items: Array<{ action: string; entityType: string; entityId: string; hash: string }>
    }>(request, mySession, 'GET', '/api/audit', {
      query: { entityType: 'customer', entityId: customerId },
    })
    expect(customerEvents.status).toBe(200)
    const createdEvent = customerEvents.body.items.find((e) => e.action === 'CUSTOMER_CREATED')
    expect(createdEvent, JSON.stringify(customerEvents.body.items)).toBeTruthy()
    expect(createdEvent!.entityId).toBe(customerId)
    expect(createdEvent!.hash).toBeTruthy() // the tamper-evident chain (ADR-0020) is populated

    if (RECEIVABLES_JOURNEY_READY) {
      const { invoiceId, receiptId } = state as JourneyState

      const invoiceEvents = await apiCall<{ items: Array<{ action: string }> }>(
        request,
        mySession,
        'GET',
        '/api/audit',
        { query: { entityType: 'sales_invoice', entityId: invoiceId } },
      )
      expect(invoiceEvents.body.items.some((e) => /POST/i.test(e.action))).toBe(true)
      expect(invoiceEvents.body.items.some((e) => /REVERS/i.test(e.action))).toBe(true)

      const receiptEvents = await apiCall<{ items: Array<{ action: string }> }>(
        request,
        mySession,
        'GET',
        '/api/audit',
        { query: { entityType: 'customer_receipt', entityId: receiptId } },
      )
      expect(receiptEvents.body.items.some((e) => /POST/i.test(e.action))).toBe(true)
      expect(receiptEvents.body.items.some((e) => /REVERS/i.test(e.action))).toBe(true)
    }
  })

  // ── 10. the other tenant sees none of it ──────────────────────────────────────────────────
  await test.step('10. the other tenant sees none of it', async () => {
    const otherSession = await apiLogin(
      request,
      baseUrl,
      other.code,
      other.accountantEmail,
      other.password,
    )

    // A cross-tenant id is the SAME 404 an unknown id gets (api-contract.md §1) — never a 403,
    // which would confirm the id exists.
    const crossCustomer = await apiCall(
      request,
      otherSession,
      'GET',
      `/api/customers/${customerId}`,
    )
    expect(crossCustomer.status).toBe(404)

    const crossLedger = await apiCall(
      request,
      otherSession,
      'GET',
      `/api/customers/${customerId}/ledger`,
    )
    expect(crossLedger.status).toBe(404)

    const crossList = await apiCall<{ items: Array<{ id: string }> }>(
      request,
      otherSession,
      'GET',
      '/api/customers',
      { query: { q: customerName } },
    )
    expect(crossList.status).toBe(200)
    expect(crossList.body.items.some((c) => c.id === customerId)).toBe(false)

    // RLS-scoped, not id-scoped: the query succeeds (200), it just never returns tenant A's row.
    const crossAudit = await apiCall<{ items: unknown[] }>(
      request,
      otherSession,
      'GET',
      '/api/audit',
      {
        query: { entityType: 'customer', entityId: customerId },
      },
    )
    expect(crossAudit.status).toBe(200)
    expect(crossAudit.body.items).toEqual([])

    if (RECEIVABLES_JOURNEY_READY) {
      const { invoiceId, receiptId } = state as JourneyState
      const crossInvoice = await apiCall(request, otherSession, 'GET', `/api/invoices/${invoiceId}`)
      expect(crossInvoice.status).toBe(404)
      const crossReceipt = await apiCall(request, otherSession, 'GET', `/api/receipts/${receiptId}`)
      expect(crossReceipt.status).toBe(404)

      // Adversarial, through the real UI too: signed into the OTHER tenant, in its own browser
      // context, nothing of tenant A's journey renders anywhere.
      const otherContext = await browser.newContext()
      const otherPage = await otherContext.newPage()
      await login(otherPage, other.code, other.accountantEmail, other.password)
      await otherPage.goto('/trial-balance')
      await expect(otherPage.getByText(customerName)).toHaveCount(0)
      await otherContext.close()
    }
  })
}

test.describe('MVP journey (real API, disposable tenants)', () => {
  test('tenant A: customer -> service invoice -> receipt -> reversal', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(RECEIVABLES_JOURNEY_READY ? 90_000 : 30_000)
    await runJourney(page, request, browser, tenantA, tenantB)
  })

  test('tenant B: the same journey, independently', async ({ page, request, browser }) => {
    test.setTimeout(RECEIVABLES_JOURNEY_READY ? 90_000 : 30_000)
    await runJourney(page, request, browser, tenantB, tenantA)
  })
})
