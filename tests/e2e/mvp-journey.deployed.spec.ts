import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { apiCall, newIdempotencyKey, type ApiSession } from './helpers/api-client.ts'
import { rs, twoDp } from './helpers/money.ts'
import { reverseLeftovers, type PostedDocs } from './helpers/reversal-cleanup.ts'

/*
 * The MVP journey (see mvp-journey.spec.ts for the full step-by-step rationale — this file does
 * not repeat it) run against a REAL deployment, on the two demo tenants BHATTI1/BHATTI2
 * (tools/seed/demo-tenants.mjs). Driven by playwright.deployed.config.ts, which only matches
 * `*.deployed.spec.ts` and starts nothing itself — it expects `E2E_BASE_URL` already up.
 *
 * ── Opt-in only, and never a hardcoded or file-read secret ────────────────────────────────────
 *
 * This file runs ONLY when every one of E2E_BASE_URL (playwright.deployed.config.ts already
 * throws without it), E2E_BHATTI1_ACCOUNTANT_PASSWORD and E2E_BHATTI2_ACCOUNTANT_PASSWORD is set
 * in the environment. No default, no fallback, no file it goes looking for — tools/seed/
 * demo-tenants.mjs's own header is the precedent: credentials for these tenants live in a
 * 0600 file OUTSIDE this repository that only a human (the Product Owner) reads, and an agent
 * or CI job is never the one to open it. Whoever runs this file exports the two password
 * variables themselves, from wherever they keep that file.
 *
 * Nothing here ever logs a password or writes one to a trace, screenshot or video: `test.use`
 * below turns all three off for this file only (playwright.deployed.config.ts's own
 * trace/screenshot settings, shared with web-origin.deployed.spec.ts, are left untouched — this
 * is an override, not an edit to that file). The access token IS allowed to appear in Playwright's
 * own console/error output if an assertion fails — it is a 15-minute session credential the
 * server can and does revoke, not the account password — but this file still never
 * `console.log`s it deliberately.
 *
 * Security review (this commit): `locator.fill(password)` renders the literal value into
 * Playwright's own step/action description ("Fill \"<password>\""), which an HTML or JSON
 * reporter — or a trace, already off above — would persist. `playwright.deployed.config.ts`
 * already pins `reporter: [['list']]` for every `*.deployed.spec.ts` file, which does not do
 * that, but `docs/workflows/mvp-journey.md`'s documented command ALSO passes `--reporter=list`
 * explicitly, so a manual `--reporter=html` override at the command line cannot reintroduce it.
 * `docs/workflows/mvp-journey.md` also never has the Product Owner paste a password into a
 * command string (shell history) — it reads each one with `read -s` / `Read-Host
 * -AsSecureString` instead — and says explicitly: never paste a password through `!` in a
 * Claude session, or into any agent chat, to set one of these variables. Type it at your own
 * terminal's prompt, direct into the shell that will export it, nowhere else.
 *
 * ── Retries and cleanup ────────────────────────────────────────────────────────────────────────
 *
 * `test.describe.configure({ retries: 0 })` below overrides `playwright.deployed.config.ts`'s
 * file-wide `retries: 1` for this suite specifically: that retry exists for a flaky network hop
 * against a real host, which is the right call for a read-only check like
 * web-origin.deployed.spec.ts, and the wrong one here — a failure AFTER this file has posted
 * real money would otherwise re-run the whole journey and post a SECOND, unreversed set on a
 * shared demo tenant. Each tenant's own `test.afterAll` is the safety net for the case that
 * still matters: this run's OWN test failing partway through, after the invoice or receipt
 * posted but before step 7 reversed it. The full logic lives in
 * tests/e2e/helpers/reversal-cleanup.ts, factored out specifically so it could be unit-tested
 * (reversal-cleanup.spec.ts) rather than trusted on the strength of one e2e run — read that
 * file's own header for the complete reasoning, including the defence-in-depth added after a
 * THIRD security review round: I1/R1's `customerId` filter is not implemented yet, so cleanup
 * never reverses anything without also checking, client-side, that the document's own
 * `customer.id` actually matches this run's customer, and refuses outright (throwing without
 * reversing anything) if a list ever comes back longer than the two documents — one invoice, one
 * receipt — this run could ever have created.
 */

const BHATTI_TENANTS = [
  { code: 'BHATTI1', passwordEnv: 'E2E_BHATTI1_ACCOUNTANT_PASSWORD' },
  { code: 'BHATTI2', passwordEnv: 'E2E_BHATTI2_ACCOUNTANT_PASSWORD' },
] as const

// tools/seed/demo-tenants.mjs's own `demoEmail()`: `${localPart}@${tenantCode.toLowerCase()}.demo`.
function accountantEmail(tenantCode: string): string {
  return `accountant@${tenantCode.toLowerCase()}.demo`
}

function missingOptInVars(): string[] {
  const missing: string[] = []
  if (!process.env.E2E_BASE_URL) missing.push('E2E_BASE_URL')
  for (const t of BHATTI_TENANTS) {
    if (!process.env[t.passwordEnv] || process.env[t.passwordEnv]!.trim() === '') {
      missing.push(t.passwordEnv)
    }
  }
  return missing
}

const OPT_IN_MISSING = missingOptInVars()

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

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
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })
  return body.accessToken
}

/*
 * Gated by never REGISTERING a test case, not by `test.skip` — AGENTS.md rule 4 / this repo's
 * own ESLint rule bans `test.skip` outright ("never disable a test to reach green"; a hard lint
 * error on the member expression, not a style preference). That rule is about not silencing a
 * test that WOULD otherwise run and fail; this is a different situation, the same one
 * playwright.config.ts's own `testMatch` already models for every `*.deployed.spec.ts` file —
 * excluded from a run, not present-but-skipped in it. Without the opt-in vars there is no base
 * URL and no password to run these cases AGAINST, so zero cases are registered, and the one
 * `test()` below that always runs says exactly why.
 */
if (OPT_IN_MISSING.length > 0) {
  test('deployed MVP journey did not run: opted out', () => {
    test.info().annotations.push({
      type: 'opted-out',
      description:
        `Set ${OPT_IN_MISSING.join(', ')} to run it. ` +
        'See docs/workflows/mvp-journey.md for how the Product Owner runs this against staging.',
    })
  })
} else {
  test.describe('MVP journey (deployed — BHATTI1/BHATTI2)', () => {
    // Security review: a failure AFTER this run has posted real money must never be retried —
    // a retry would post a SECOND, unreversed set on a shared demo tenant. See the file header.
    test.describe.configure({ retries: 0 })

    for (const tenant of BHATTI_TENANTS) {
      test.describe(tenant.code, () => {
        const posted: PostedDocs = {}

        test.afterAll(async ({ request }) => {
          await reverseLeftovers(request, posted)
        })

        test(`${tenant.code}: customer -> invoice -> receipt -> reversal, net zero afterwards`, async ({
          page,
          request,
        }) => {
          test.setTimeout(120_000)

          const baseUrl = process.env.E2E_BASE_URL!
          const password = process.env[tenant.passwordEnv]!
          const email = accountantEmail(tenant.code)

          let session!: ApiSession
          await test.step('1. log in', async () => {
            const accessToken = await login(page, tenant.code, email, password)
            session = { baseUrl, tenantCode: tenant.code, accessToken }
            posted.session = session
          })

          // A unique name per run (brief requirement): this posts real documents on a shared demo
          // tenant, and a fixed name would collide with the previous run's own reversed-but-still-
          // visible customer (rule 4: nothing is ever deleted).
          const customerName = `MVP Journey Check ${new Date().toISOString().slice(0, 10)} ${randomUUID().slice(0, 8)}`
          let customerId = ''

          await test.step('2. create a customer', async () => {
            const created = await apiCall<{ id: string; code: string; balance: string }>(
              request,
              session,
              'POST',
              '/api/customers',
              {
                data: {
                  name: customerName,
                  phone: null,
                  email: null,
                  address: null,
                  city: null,
                  ntn: null,
                  creditDays: 30,
                },
                idempotencyKey: newIdempotencyKey(),
              },
            )
            expect(created.status, JSON.stringify(created.body)).toBe(201)
            expect(created.body.balance).toBe('0.0000')
            customerId = created.body.id
            // Known from here on, long before either document exists — see `PostedDocs`'s own
            // comment for why this alone is enough for `afterAll` to find anything this run posts.
            posted.customerId = customerId
            posted.customerName = customerName
          })

          let invoiceId = ''
          let invoiceNumber = ''
          let receiptId = ''

          // Same selectors and sequence as mvp-journey.spec.ts's gated steps 3-4 — see that file for
          // the full rationale on each one. Duplicated rather than shared because the two specs run
          // under different Playwright configs (this one starts nothing and points at a live host);
          // a shared helper would need its own `page`/`request` plumbing that buys little here.
          await test.step('3. post a service invoice for 10,000', async () => {
            await page.goto(`/sales/voucher?customer=${customerId}`)
            await expect(page.getByText(customerName)).toBeVisible()
            await page.getByLabel(/^narration/i).fill('E2E deployed check: service invoice')

            await page.getByLabel(/description.*line 1/i).fill('Monthly maintenance')
            await page.getByLabel(/qty.*line 1/i).fill('1')
            await page.getByLabel(/rate.*line 1/i).fill('7500')
            await expect(page.getByText(twoDp('7500'))).toBeVisible({ timeout: 10_000 })

            await page.getByRole('button', { name: /add row/i }).click()
            await page.getByLabel(/description.*line 2/i).fill('Site visit')
            await page.getByLabel(/qty.*line 2/i).fill('3')
            await page.getByLabel(/rate.*line 2/i).fill('833.333333')
            await expect(page.getByText(twoDp('2500'))).toBeVisible({ timeout: 10_000 })
            await expect(page.getByText(twoDp('10000'))).toBeVisible()

            const postButton = page.getByRole('button', { name: /save\s*&\s*post/i })
            await expect(postButton).toBeEnabled()
            await postButton.click()
            const confirmDialog = page.getByRole('dialog', {
              name: /save\s*&\s*post|post invoice/i,
            })
            await expect(confirmDialog.getByText(rs('10000')).first()).toBeVisible()
            // Flagged the instant before the click that actually calls I7 (post), not after the
            // heading below renders — a post that succeeds on the server and then fails to
            // render (a network blip, a slow redirect) must still be found by `afterAll`, and an
            // id captured only from that heading would never exist to find it with. See
            // `PostedDocs`'s own comment.
            posted.invoicePossiblyPosted = true
            await confirmDialog
              .getByRole('button', { name: /save\s*&\s*post|post invoice/i })
              .click()

            await expect(page).toHaveURL(/\/sales\/.+/, { timeout: 20_000 })
            const heading = page.getByRole('heading', { level: 1 })
            await expect(heading).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 20_000 })
            invoiceNumber = (await heading.textContent())!.trim()
            invoiceId = new URL(page.url()).pathname.split('/').pop()!
          })

          await test.step('4. receive 6,000 against it', async () => {
            await page.goto(`/payments?customer=${customerId}&invoice=${invoiceId}`)
            await page.getByLabel(/amount received/i).fill('6000')
            const bankOption = page
              .getByRole('radio', { name: 'Bank', exact: true })
              .or(page.getByRole('button', { name: 'Bank', exact: true }))
            await bankOption.click()
            await page.getByRole('button', { name: /auto-allocate/i }).click()
            await expect(page.getByRole('row', { name: new RegExp(invoiceNumber) })).toContainText(
              twoDp('6000'),
            )

            await page.getByRole('button', { name: /save draft/i }).click()
            await expect(page.getByText(/draft/i)).toBeVisible({ timeout: 20_000 })

            await page.goto('/payments')
            await page.getByText(/draft/i).first().click()
            await page.getByRole('button', { name: /^open$/i }).click()
            await expect(page).toHaveURL(/\/payments\/.+/, { timeout: 20_000 })
            receiptId = new URL(page.url()).pathname.split('/').pop()!

            const postButton = page.getByRole('button', { name: /^post$/i })
            await expect(postButton).toBeEnabled()
            await postButton.click()
            const confirmDialog = page.getByRole('dialog', { name: /post/i })
            await expect(confirmDialog.getByText(rs('6000')).first()).toBeVisible()
            // Same reasoning as the invoice's flag above: before the click that actually calls
            // R6, not after.
            posted.receiptPossiblyPosted = true
            await confirmDialog.getByRole('button', { name: /^post$/i }).click()
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^RCT-\d{4}-\d{6}$/, {
              timeout: 20_000,
            })
          })

          await test.step('5. the customer ledger shows 4,000', async () => {
            const ledger = await apiCall<{ closingBalance: string }>(
              request,
              session,
              'GET',
              `/api/customers/${customerId}/ledger`,
            )
            expect(ledger.body.closingBalance).toBe('4000.0000')
          })

          // This step reverses through the real UI deliberately — proving the actual screens a
          // human would use to correct a posting error, not just that the API can do it. The
          // OTHER safety net (each tenant's `test.afterAll` above, `reverseLeftovers`) exists for
          // exactly the case this step itself cannot cover: this test failing before reaching
          // here, with real money already posted. That net calls the API directly rather than
          // the UI, because a broken screen is exactly the failure it needs to survive — and it
          // re-lists rather than trusting a flag was cleared, so if THIS step already succeeded,
          // `afterAll`'s own list call simply finds nothing left `POSTED` and does nothing.
          await test.step('7. reverse the receipt, then the invoice (PO-Q1)', async () => {
            await page.goto(`/sales/${invoiceId}`)
            await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toBeDisabled()

            await page.goto(`/payments/${receiptId}`)
            await page.getByRole('button', { name: 'Reverse', exact: true }).click()
            await page.getByLabel(/^reason/i).fill('E2E deployed check cleanup: receipt reversal')
            await page.getByLabel(/I understand this cannot be undone/i).check()
            await page.getByRole('button', { name: /reverse receipt/i }).click()
            await expect(page.getByText('Reversed', { exact: true })).toBeVisible({
              timeout: 20_000,
            })

            await page.goto(`/sales/${invoiceId}`)
            await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toBeEnabled()
            await page.getByRole('button', { name: 'Reverse', exact: true }).click()
            await page.getByLabel(/^reason/i).fill('E2E deployed check cleanup: invoice reversal')
            await page.getByLabel(/I understand this cannot be undone/i).check()
            await page.getByRole('button', { name: /reverse invoice/i }).click()
            await expect(page.getByText('Reversed', { exact: true })).toBeVisible({
              timeout: 20_000,
            })
          })

          await test.step('8. net zero — the ledger and TB are correct again', async () => {
            const ledger = await apiCall<{ closingBalance: string }>(
              request,
              session,
              'GET',
              `/api/customers/${customerId}/ledger`,
            )
            expect(ledger.body.closingBalance).toBe('0.0000')

            await page.goto('/trial-balance')
            await expect(page.getByText(/^Balanced/)).toBeVisible({ timeout: 20_000 })
          })

          // No period was closed or reopened anywhere in this run (brief requirement: leave no
          // fiscal period closed) — this journey never calls a period endpoint, so there is
          // nothing to assert back to open; noted here so the absence is a documented decision,
          // not a gap.
        })
      })
    }
  })
}
